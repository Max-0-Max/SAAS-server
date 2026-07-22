const express = require('express');
const multer = require('multer');
const Task = require('../models/Task');
const User = require('../models/User');
const Comment = require('../models/Comment');
const NotificationPrefs = require('../models/NotificationPrefs');
const authMiddleware = require('../middleware/auth');
const { sendEmail } = require('../jobs/notificationJob');
const { uploadBuffer, deleteAsset, isConfigured } = require('../utils/cloudinary');

const router = express.Router();
router.use(authMiddleware);

// Memory storage only — files go straight to Cloudinary from RAM, never
// written to local disk (which doesn't reliably persist on Vercel).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10MB per file, 5 files per comment
});

/* ── Helper: can this user see (and therefore comment on) this task? ──
   Same visibility rule used everywhere else — owner or assignee, any role. ── */
async function getTaskIfVisible(taskId, userId) {
  const task = await Task.findById(taskId);
  if (!task) return null;
  const isOwner = String(task.user_id) === String(userId);
  const isAssignee = task.assigned_to && String(task.assigned_to) === String(userId);
  return (isOwner || isAssignee) ? task : null;
}

function formatComment(c, authorName) {
  return {
    id: c._id,
    task_id: c.task_id,
    author_id: c.author_id,
    author_name: authorName,
    body: c.body,
    attachments: c.attachments.map(a => ({ url: a.url, filename: a.filename, size: a.size, mimetype: a.mimetype })),
    edited: c.edited,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/* ── Best-effort email to the other party when a comment is posted.
   Owner comments -> notify assignee; assignee comments -> notify owner. ── */
async function notifyOnComment({ task, commenterId, commentBody }) {
  try {
    const isCommenterOwner = String(task.user_id) === String(commenterId);
    const recipientId = isCommenterOwner ? task.assigned_to : task.user_id;
    if (!recipientId || String(recipientId) === String(commenterId)) return; // no one else to notify

    const [recipient, commenter, prefs] = await Promise.all([
      User.findById(recipientId).select('name email'),
      User.findById(commenterId).select('name'),
      NotificationPrefs.findOne({ user_id: recipientId }),
    ]);
    if (!recipient || !recipient.email) return;
    if (prefs && prefs.email_tasks === false) return;

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const preview = commentBody.length > 200 ? commentBody.slice(0, 200) + '…' : commentBody;
    await sendEmail({
      to: recipient.email,
      subject: `💬 ${commenter?.name || 'Someone'} commented on "${task.title}" — Nexus`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#6C47FF,#A855F7);padding:28px 32px;border-radius:16px 16px 0 0;">
            <h1 style="margin:0;color:white;font-size:22px;">✦ Nexus</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e8e7f0;border-top:none;">
            <h2 style="margin:0 0 12px;color:#1a1a2e;">New comment 💬</h2>
            <p style="color:#555;margin:0 0 8px;"><strong>${commenter?.name || 'Someone'}</strong> commented on <strong>${task.title}</strong>:</p>
            <div style="padding:14px 16px;background:#f9f9ff;border-left:4px solid #6C47FF;border-radius:8px;margin:12px 0 24px;">
              <p style="margin:0;font-size:14px;color:#333;">${preview || '(attachment only)'}</p>
            </div>
            <a href="${clientUrl}/projects" style="display:inline-block;padding:13px 28px;background:#6C47FF;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              View task →
            </a>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('notifyOnComment failed:', err.message);
  }
}

/* ── LIST comments on a task ── */
router.get('/task/:taskId', async (req, res) => {
  try {
    const task = await getTaskIfVisible(req.params.taskId, req.userId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const comments = await Comment.find({ task_id: task._id }).sort({ created_at: 1 });
    const authorIds = [...new Set(comments.map(c => String(c.author_id)))];
    const authors = await User.find({ _id: { $in: authorIds } }).select('name email');
    const authorMap = Object.fromEntries(authors.map(a => [String(a._id), a.name || a.email]));

    res.json(comments.map(c => formatComment(c, authorMap[String(c.author_id)] || 'Someone')));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE a comment (with optional attachments) ── */
router.post('/task/:taskId', upload.array('attachments', 5), async (req, res) => {
  try {
    const task = await getTaskIfVisible(req.params.taskId, req.userId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const body = (req.body.body || '').trim();
    const files = req.files || [];
    if (!body && files.length === 0) {
      return res.status(400).json({ message: 'Comment needs text or at least one attachment' });
    }
    if (files.length > 0 && !isConfigured()) {
      return res.status(500).json({ message: 'File attachments are not configured on the server yet.' });
    }

    const attachments = [];
    for (const file of files) {
      try {
        const result = await uploadBuffer(file.buffer, { folder: `nexus/tasks/${task._id}` });
        attachments.push({
          url: result.secure_url, public_id: result.public_id,
          filename: file.originalname, size: file.size, mimetype: file.mimetype,
        });
      } catch (err) {
        console.error('Attachment upload failed:', file.originalname, err.message);
        return res.status(500).json({ message: `Failed to upload "${file.originalname}"` });
      }
    }

    const comment = await Comment.create({ task_id: task._id, author_id: req.userId, body, attachments });
    const author = await User.findById(req.userId).select('name email');

    notifyOnComment({ task, commenterId: req.userId, commentBody: body });

    res.status(201).json(formatComment(comment, author?.name || author?.email || 'Someone'));
  } catch (err) {
    console.error('POST /comments/task/:taskId', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

/* ── EDIT own comment (text only — attachments are immutable once posted) ── */
router.put('/:commentId', async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });
    if (String(comment.author_id) !== String(req.userId)) {
      return res.status(403).json({ message: 'You can only edit your own comments' });
    }
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ message: 'Comment body is required' });

    comment.body = body;
    comment.edited = true;
    comment.updated_at = new Date();
    await comment.save();

    const author = await User.findById(comment.author_id).select('name email');
    res.json(formatComment(comment, author?.name || author?.email || 'Someone'));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE — author or task owner ── */
router.delete('/:commentId', async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    const task = await Task.findById(comment.task_id);
    const isAuthor = String(comment.author_id) === String(req.userId);
    const isTaskOwner = task && String(task.user_id) === String(req.userId);
    if (!isAuthor && !isTaskOwner) return res.status(403).json({ message: 'Not allowed to delete this comment' });

    await Promise.all(comment.attachments.map(a => deleteAsset(a.public_id)));
    await Comment.deleteOne({ _id: comment._id });

    res.json({ message: 'Comment deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

module.exports = router;
