const express = require('express');
const Note    = require('../models/Note');
const User    = require('../models/User');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 10, pro: Infinity, enterprise: Infinity };

const router = express.Router();
router.use(authMiddleware);

/* ── LIST ── */
router.get('/', async (req, res) => {
  try {
    const notes = await Note.find({ user_id: req.userId }).sort({ pinned: -1, updated_at: -1 });
    res.json(notes.map(formatNote));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const user  = await User.findById(req.userId);
    const tier  = user?.subscription_tier || 'free';
    const limit = PLAN_LIMITS[tier];

    if (isFinite(limit)) {
      const count = await Note.countDocuments({ user_id: req.userId });
      if (count >= limit) {
        return res.status(403).json({
          message: `Free plan is limited to ${limit} notes. Upgrade to Pro for unlimited notes.`,
          upgradeRequired: true,
        });
      }
    }

    const { title, content, color, pinned, tags } = req.body;
    const note = new Note({ user_id: req.userId, title, content, color, pinned, tags });
    await note.save();
    res.status(201).json(formatNote(note));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ── */
router.put('/:id', async (req, res) => {
  try {
    const note = await Note.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!note) return res.status(404).json({ message: 'Note not found' });
    res.json(formatNote(note));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const note = await Note.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!note) return res.status(404).json({ message: 'Note not found' });
    res.json({ message: 'Note deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

function formatNote(n) {
  return {
    id:         n._id,
    user_id:    n.user_id,
    title:      n.title,
    content:    n.content,
    color:      n.color,
    pinned:     n.pinned,
    tags:       n.tags,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

module.exports = router;
