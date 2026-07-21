const express = require('express');
const Task    = require('../models/Task');
const User    = require('../models/User');
const TeamMember = require('../models/TeamMember');
const NotificationPrefs = require('../models/NotificationPrefs');
const { logActivity } = require('../utils/activityLogger');
const ActivityLog = require('../models/ActivityLog');
const { sendEmail, formatFriendlyDateTime } = require('../jobs/notificationJob');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 50, pro: Infinity, enterprise: Infinity }; // 50 tasks per project

const router = express.Router();
router.use(authMiddleware);

/* ── LIST (optionally filter by project_id) ──
   Returns tasks the user owns AND tasks assigned to them by someone else. ── */
router.get('/', async (req, res) => {
  try {
    const filter = { $or: [{ user_id: req.userId }, { assigned_to: req.userId }] };
    if (req.query.project_id) filter.project_id = req.query.project_id;
    const tasks = await Task.find(filter).sort({ position: 1, created_at: -1 });

    // For tasks assigned to me by someone else, attach my role in their team
    // so the frontend knows whether I'm allowed to change its status
    // (viewers are read-only).
    const results = await Promise.all(tasks.map(async t => {
      const formatted = formatTask(t);
      if (t.assigned_to && String(t.assigned_to) === String(req.userId) && String(t.user_id) !== String(req.userId)) {
        formatted.assignee_role = await getRoleInTeam(t.user_id, req.userId);
      }
      return formatted;
    }));
    res.json(results);
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── Helper: what role does userId hold in ownerId's team?
   Returns 'owner' | 'admin' | 'member' | 'viewer' | null (not on the team). ── */
async function getRoleInTeam(ownerId, userId) {
  if (String(ownerId) === String(userId)) return 'owner';
  const member = await TeamMember.findOne({ owner_id: ownerId, user_id: userId, status: 'active' });
  return member ? member.role : null;
}

/* ── Helper: verify assigned_to (if provided) is an active member of this
   owner's workspace, and return it normalized (null if unset/self isn't
   restricted — owners can assign to themselves freely). ── */
async function resolveAssignee(ownerId, assignedTo) {
  if (!assignedTo) return null;
  if (String(assignedTo) === String(ownerId)) return assignedTo; // assigning to yourself is always fine
  const member = await TeamMember.findOne({ owner_id: ownerId, user_id: assignedTo, status: 'active' });
  if (!member) {
    const err = new Error('That person is not an active member of your team.');
    err.statusCode = 400;
    throw err;
  }
  return assignedTo;
}

/* ── Helper: best-effort email to the assignee when a task is assigned to
   someone other than the task owner. Never throws. ── */
async function notifyAssignee({ assignedTo, ownerId, task }) {
  try {
    if (!assignedTo || String(assignedTo) === String(ownerId)) return;
    const [assignee, owner, prefs] = await Promise.all([
      User.findById(assignedTo).select('name email'),
      User.findById(ownerId).select('name email'),
      NotificationPrefs.findOne({ user_id: assignedTo }),
    ]);
    if (!assignee || !assignee.email) return;
    if (prefs && prefs.email_tasks === false) return; // respect their preference

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    await sendEmail({
      to: assignee.email,
      subject: `📌 ${owner?.name || 'Someone'} assigned you a task — Nexus`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#6C47FF,#A855F7);padding:28px 32px;border-radius:16px 16px 0 0;">
            <h1 style="margin:0;color:white;font-size:22px;">✦ Nexus</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e8e7f0;border-top:none;">
            <h2 style="margin:0 0 12px;color:#1a1a2e;">You've been assigned a task 📌</h2>
            <p style="color:#555;margin:0 0 8px;"><strong>${owner?.name || 'A teammate'}</strong> assigned you:</p>
            <div style="padding:14px 16px;background:#f9f9ff;border-left:4px solid #6C47FF;border-radius:8px;margin:12px 0 24px;">
              <p style="margin:0;font-weight:600;font-size:15px;">${task.title}</p>
              ${task.due_date ? `<p style="margin:4px 0 0;font-size:12px;color:#888;">Due: ${formatFriendlyDateTime(task.due_date)}</p>` : ''}
            </div>
            <a href="${clientUrl}/projects"
               style="display:inline-block;padding:13px 28px;background:#6C47FF;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
              View task →
            </a>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('notifyAssignee failed:', err.message);
  }
}

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, due_date, position, assigned_to } = req.body;

    const user  = await User.findById(req.userId);
    const tier  = user?.subscription_tier || 'free';
    const limit = PLAN_LIMITS[tier];

    if (isFinite(limit) && project_id) {
      const count = await Task.countDocuments({ user_id: req.userId, project_id });
      if (count >= limit) {
        return res.status(403).json({
          message: `Free plan is limited to ${limit} tasks per project. Upgrade to Pro for unlimited tasks.`,
          upgradeRequired: true,
        });
      }
    }

    let resolvedAssignee;
    try {
      resolvedAssignee = await resolveAssignee(req.userId, assigned_to);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ message: err.message });
    }

    const task = new Task({ user_id: req.userId, project_id, title, description, status, priority, due_date, position, assigned_to: resolvedAssignee });
    await task.save();
    await notifyAssignee({ assignedTo: resolvedAssignee, ownerId: req.userId, task });
    await logActivity({ taskId: task._id, projectId: task.project_id, actorId: req.userId, action: 'created', title: task.title });
    res.status(201).json(formatTask(task));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── REORDER (drag-and-drop) ── Owner only.
   Body: { updates: [{ id, position, status }, ...] } — one entry per task
   whose position and/or status changed as a result of the drag. Only
   touches tasks the requester actually owns; anything else is silently
   skipped rather than erroring the whole batch. ── */
router.put('/reorder', async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ message: 'updates array is required' });
    }
    if (updates.length > 200) {
      return res.status(400).json({ message: 'Too many updates in one batch' });
    }

    // Fetch current state first so we can tell which of these are just
    // reorders (position only) vs an actual status change (drag between
    // columns) — only the latter gets logged.
    const ids = updates.filter(u => u && u.id).map(u => u.id);
    const currentTasks = await Task.find({ _id: { $in: ids }, user_id: req.userId });
    const currentById = Object.fromEntries(currentTasks.map(t => [String(t._id), t]));

    const results = await Promise.all(updates.map(async u => {
      if (!u || !u.id) return null;
      const current = currentById[u.id];
      if (!current) return null; // not found or not owned by this user

      const set = {};
      if (typeof u.position === 'number') set.position = u.position;
      if (typeof u.status === 'string') set.status = u.status;
      if (Object.keys(set).length === 0) return null;
      set.updated_at = new Date();

      const updated = await Task.findOneAndUpdate({ _id: u.id, user_id: req.userId }, set, { new: true });
      if (!updated) return null;

      if (typeof u.status === 'string' && u.status !== current.status) {
        await logActivity({
          taskId: updated._id, projectId: updated.project_id, actorId: req.userId,
          action: 'status_changed', details: { from: current.status, to: u.status }, title: updated.title,
        });
      }
      return formatTask(updated);
    }));

    res.json(results.filter(Boolean));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ──
   Owners can edit any field, including reassigning the task.
   Assignees (who don't own the task) can only update its status. ── */
router.put('/:id', async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const isOwner = String(task.user_id) === String(req.userId);
    const isAssignee = task.assigned_to && String(task.assigned_to) === String(req.userId);
    if (!isOwner && !isAssignee) return res.status(404).json({ message: 'Task not found' });

    let updates;
    const activityEntries = [];

    if (isOwner) {
      updates = { ...req.body };
      if ('assigned_to' in updates) {
        let resolvedAssignee;
        try {
          resolvedAssignee = await resolveAssignee(req.userId, updates.assigned_to);
        } catch (err) {
          return res.status(err.statusCode || 400).json({ message: err.message });
        }
        const assigneeChanged = String(task.assigned_to || '') !== String(resolvedAssignee || '');
        updates.assigned_to = resolvedAssignee;
        if (assigneeChanged) {
          await notifyAssignee({ assignedTo: resolvedAssignee, ownerId: req.userId, task: { ...task.toObject(), ...updates } });
          const action = !task.assigned_to ? 'assigned' : !resolvedAssignee ? 'unassigned' : 'reassigned';
          activityEntries.push({ action, details: { from: task.assigned_to || null, to: resolvedAssignee || null } });
        }
      }
      if ('due_date' in updates && String(updates.due_date || '') !== String(task.due_date || '')) {
        updates.reminder_60_sent = false;
        updates.reminder_30_sent = false;
        activityEntries.push({ action: 'due_date_changed', details: { from: task.due_date || null, to: updates.due_date || null } });
      }
      if ('status' in updates && updates.status !== task.status) {
        activityEntries.push({ action: 'status_changed', details: { from: task.status, to: updates.status } });
      }
      if (('title' in updates && updates.title !== task.title) || ('description' in updates && updates.description !== task.description)) {
        activityEntries.push({ action: 'edited', details: {} });
      }
    } else {
      // Assignee: status changes only, nothing else — and only if their role
      // in the task owner's team allows it. Viewers are read-only.
      if (!('status' in req.body)) return res.status(403).json({ message: 'You can only update this task\'s status' });
      const role = await getRoleInTeam(task.user_id, req.userId);
      if (role === 'viewer') return res.status(403).json({ message: 'Viewers can view assigned tasks but can\'t update their status.' });
      updates = { status: req.body.status };
      if (updates.status !== task.status) {
        activityEntries.push({ action: 'status_changed', details: { from: task.status, to: updates.status } });
      }
    }

    const updated = await Task.findByIdAndUpdate(req.params.id, { ...updates, updated_at: new Date() }, { new: true });
    await Promise.all(activityEntries.map(entry => logActivity({
      taskId: task._id, projectId: task.project_id, actorId: req.userId, title: updated.title, ...entry,
    })));
    res.json(formatTask(updated));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user_id: req.userId });
    if (!task) return res.status(404).json({ message: 'Task not found' });
    await logActivity({ taskId: task._id, projectId: task.project_id, actorId: req.userId, action: 'deleted', title: task.title });
    await Task.deleteOne({ _id: task._id });
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── ACTIVITY — history of changes on a task ──
   Visible to the task owner and its assignee (same visibility as the task
   itself). Actor names are resolved for display. ── */
router.get('/:id/activity', async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const isOwner = String(task.user_id) === String(req.userId);
    const isAssignee = task.assigned_to && String(task.assigned_to) === String(req.userId);
    if (!isOwner && !isAssignee) return res.status(404).json({ message: 'Task not found' });

    const entries = await ActivityLog.find({ task_id: task._id }).sort({ created_at: -1 }).limit(100);
    const actorIds = [...new Set(entries.map(e => String(e.actor_id)))];
    const actors = await User.find({ _id: { $in: actorIds } }).select('name email');
    const actorMap = Object.fromEntries(actors.map(a => [String(a._id), a.name || a.email]));

    res.json(entries.map(e => ({
      id: e._id,
      action: e.action,
      details: e.details,
      actor_name: actorMap[String(e.actor_id)] || 'Someone',
      actor_id: e.actor_id,
      created_at: e.created_at,
    })));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

function formatTask(t) {
  return {
    id:          t._id,
    user_id:     t.user_id,
    project_id:  t.project_id,
    title:       t.title,
    description: t.description,
    status:      t.status,
    priority:    t.priority,
    due_date:    t.due_date,
    position:    t.position,
    assigned_to: t.assigned_to || null,
    created_at:  t.created_at,
    updated_at:  t.updated_at,
  };
}

module.exports = router;
