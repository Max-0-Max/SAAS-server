const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const NotificationPrefs = require('../models/NotificationPrefs');
const TeamMember = require('../models/TeamMember');
const User = require('../models/User');
const { sendEmail } = require('../jobs/notificationJob');

/* ══════════════════════════════════════════════════════════════
   NOTIFICATION PREFERENCES
   GET  /api/notifications/prefs
   PUT  /api/notifications/prefs
══════════════════════════════════════════════════════════════ */

router.get('/prefs', authMiddleware, async (req, res) => {
  try {
    let prefs = await NotificationPrefs.findOne({ user_id: req.userId });
    if (!prefs) prefs = await NotificationPrefs.create({ user_id: req.userId });
    res.json(formatPrefs(prefs));
  } catch (err) {
    console.error('GET /prefs', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/prefs', authMiddleware, async (req, res) => {
  try {
    const { email_tasks, email_reminders, email_weekly, push_tasks, push_reminders } = req.body;
    const updates = {};
    if (email_tasks     !== undefined) updates.email_tasks     = !!email_tasks;
    if (email_reminders !== undefined) updates.email_reminders = !!email_reminders;
    if (email_weekly    !== undefined) updates.email_weekly    = !!email_weekly;
    if (push_tasks      !== undefined) updates.push_tasks      = !!push_tasks;
    if (push_reminders  !== undefined) updates.push_reminders  = !!push_reminders;

    const prefs = await NotificationPrefs.findOneAndUpdate(
      { user_id: req.userId },
      { $set: updates },
      { new: true, upsert: true }
    );
    res.json(formatPrefs(prefs));
  } catch (err) {
    console.error('PUT /prefs', err);
    res.status(500).json({ message: 'Server error' });
  }
});

function formatPrefs(p) {
  return {
    email_tasks:     p.email_tasks,
    email_reminders: p.email_reminders,
    email_weekly:    p.email_weekly,
    push_tasks:      p.push_tasks,
    push_reminders:  p.push_reminders,
  };
}

/* ══════════════════════════════════════════════════════════════
   TEAM COLLABORATION
   ⚠ ORDER MATTERS: specific routes before /:id wildcard routes
══════════════════════════════════════════════════════════════ */

// GET  /api/notifications/team          — list workspace members
router.get('/team', authMiddleware, async (req, res) => {
  try {
    const members = await TeamMember.find({ owner_id: req.userId }).sort({ createdAt: 1 });
    res.json(members.map(formatMember));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET  /api/notifications/team/accept   — accept invite via token link
// ⚠ MUST be before /team/:id routes
router.get('/team/accept', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Invalid invite link' });

    const member = await TeamMember.findOne({ invite_token: token });
    if (!member) return res.status(404).json({ message: 'Invite not found or already used' });

    const user = await User.findOne({ email: member.email });
    member.status = 'active';
    if (user) member.user_id = user._id;
    member.invite_token = null;
    await member.save();

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/auth?email=${encodeURIComponent(member.email)}&invited=1`);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/notifications/team/invite   — invite by email
// ⚠ MUST be before /team/:id routes
router.post('/team/invite', authMiddleware, async (req, res) => {
  try {
    const { email, role = 'member' } = req.body;

    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: 'Invalid email address' });
    if (!['admin', 'member', 'viewer'].includes(role))
      return res.status(400).json({ message: 'Invalid role' });

    const existing = await TeamMember.findOne({ owner_id: req.userId, email });
    if (existing) return res.status(409).json({ message: 'This person is already on your team' });

    const invitedUser = await User.findOne({ email });
    const token = crypto.randomBytes(24).toString('hex');

    const member = await TeamMember.create({
      owner_id:     req.userId,
      email,
      name:         invitedUser ? (invitedUser.name || invitedUser.email) : email.split('@')[0],
      role,
      status:       invitedUser ? 'active' : 'pending',
      user_id:      invitedUser ? invitedUser._id : null,
      invite_token: token,
    });

    // Send invite email
    const owner = await User.findById(req.userId).select('name email');
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const acceptUrl = `${clientUrl}/invite?token=${token}`;
    const roleLabel = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }[role];

    await sendEmail({
      to: email,
      subject: `${owner.name} invited you to their Nexus workspace`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#6C47FF,#A855F7);padding:28px 32px;border-radius:16px 16px 0 0;">
            <h1 style="margin:0;color:white;font-size:22px;">✦ Nexus</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e8e7f0;border-top:none;">
            <h2 style="margin:0 0 12px;color:#1a1a2e;">You've been invited! 🎉</h2>
            <p style="color:#555;margin:0 0 8px;">
              <strong>${owner.name}</strong> (${owner.email}) invited you to join their
              Nexus workspace as a <strong>${roleLabel}</strong>.
            </p>
            <p style="color:#555;margin:0 0 24px;">
              Nexus is an all-in-one productivity platform for tasks, habits, goals, and time tracking.
            </p>
            <a href="${acceptUrl}"
               style="display:inline-block;padding:13px 28px;background:#6C47FF;color:white;
                      border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              Accept Invitation →
            </a>
            <p style="color:#aaa;font-size:12px;margin-top:24px;">
              This link expires in 7 days. Ignore this email if you weren't expecting it.
            </p>
          </div>
        </div>
      `,
    });

    res.status(201).json({ message: 'Invitation sent', member: formatMember(member) });
  } catch (err) {
    console.error('POST /team/invite', err);
    if (err.code === 11000) return res.status(409).json({ message: 'This person is already on your team' });
    res.status(500).json({ message: 'Failed to send invitation' });
  }
});

// PUT  /api/notifications/team/:id/role — change a member's role
router.put('/team/:id/role', authMiddleware, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'member', 'viewer'].includes(role))
      return res.status(400).json({ message: 'Invalid role' });

    const member = await TeamMember.findOneAndUpdate(
      { _id: req.params.id, owner_id: req.userId },
      { role },
      { new: true }
    );
    if (!member) return res.status(404).json({ message: 'Member not found' });
    res.json(formatMember(member));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/notifications/team/:id   — remove a member
router.delete('/team/:id', authMiddleware, async (req, res) => {
  try {
    const member = await TeamMember.findOneAndDelete({ _id: req.params.id, owner_id: req.userId });
    if (!member) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

function formatMember(m) {
  return {
    id:       m._id,
    email:    m.email,
    name:     m.name,
    role:     m.role,
    status:   m.status,
    joinedAt: m.createdAt,
  };
}

module.exports = router;
