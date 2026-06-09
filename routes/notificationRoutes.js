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
   GET  /api/notifications/prefs       → get current user's prefs
   PUT  /api/notifications/prefs       → update prefs
══════════════════════════════════════════════════════════════ */

router.get('/prefs', authMiddleware, async (req, res) => {
  try {
    let prefs = await NotificationPrefs.findOne({ user_id: req.userId });
    if (!prefs) {
      // Create defaults on first fetch
      prefs = await NotificationPrefs.create({ user_id: req.userId });
    }
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
   GET    /api/notifications/team          → list my team members
   POST   /api/notifications/team/invite   → invite by email
   PUT    /api/notifications/team/:id/role → change role
   DELETE /api/notifications/team/:id      → remove member
   GET    /api/notifications/team/accept   → accept invite (token link)
══════════════════════════════════════════════════════════════ */

// List all members in my workspace
router.get('/team', authMiddleware, async (req, res) => {
  try {
    const members = await TeamMember.find({ owner_id: req.userId }).sort({ createdAt: 1 });
    res.json(members.map(formatMember));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Invite a new member by email
router.post('/team/invite', authMiddleware, async (req, res) => {
  try {
    const { email, role = 'member' } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: 'Invalid email address' });

    // Check not already a member
    const existing = await TeamMember.findOne({ owner_id: req.userId, email });
    if (existing) return res.status(409).json({ message: 'This person is already on your team' });

    // Check if the invited email already has a Nexus account
    const invitedUser = await User.findOne({ email });
    const token = crypto.randomBytes(24).toString('hex');

    const member = await TeamMember.create({
      owner_id: req.userId,
      email,
      name: invitedUser ? invitedUser.name : email.split('@')[0],
      role,
      status: invitedUser ? 'active' : 'pending',
      user_id: invitedUser ? invitedUser._id : null,
      invite_token: token,
    });

    // Send invite email
    const owner = await User.findById(req.userId);
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const acceptUrl = `${clientUrl}/invite?token=${token}`;

    const roleLabel = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }[role] || role;

    await sendEmail({
      to: email,
      subject: `${owner.name} invited you to their Nexus workspace`,
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
          <h2 style="color: #6C47FF;">You've been invited to Nexus 🎉</h2>
          <p><strong>${owner.name}</strong> (${owner.email}) has invited you to join their workspace as a <strong>${roleLabel}</strong>.</p>
          <p>Nexus is a productivity platform for managing tasks, habits, goals, and time — all in one place.</p>
          <a href="${acceptUrl}" style="display:inline-block; margin: 20px 0; padding: 12px 28px; background: #6C47FF; color: white; border-radius: 10px; text-decoration: none; font-weight: bold;">
            Accept Invitation →
          </a>
          <p style="color: #888; font-size: 13px;">This link expires in 7 days. If you didn't expect this, you can safely ignore it.</p>
        </div>
      `,
    });

    res.status(201).json({ message: 'Invitation sent', member: formatMember(member) });
  } catch (err) {
    console.error('POST /team/invite', err);
    res.status(500).json({ message: 'Failed to send invitation' });
  }
});

// Change a member's role
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

// Remove a member
router.delete('/team/:id', authMiddleware, async (req, res) => {
  try {
    const member = await TeamMember.findOneAndDelete({ _id: req.params.id, owner_id: req.userId });
    if (!member) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Accept invite via token (called when invited user clicks the link)
router.get('/team/accept', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Invalid invite link' });

    const member = await TeamMember.findOne({ invite_token: token });
    if (!member) return res.status(404).json({ message: 'Invite not found or already used' });

    // Try to match to an existing user
    const user = await User.findOne({ email: member.email });
    if (user) {
      member.status = 'active';
      member.user_id = user._id;
    } else {
      member.status = 'active'; // mark accepted even if they need to register
    }
    member.invite_token = null; // consume token
    await member.save();

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    // Redirect to auth with pre-filled email
    res.redirect(`${clientUrl}/auth?email=${encodeURIComponent(member.email)}&invited=1`);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

function formatMember(m) {
  return {
    id:        m._id,
    email:     m.email,
    name:      m.name,
    role:      m.role,
    status:    m.status,
    joinedAt:  m.createdAt,
  };
}

module.exports = router;
