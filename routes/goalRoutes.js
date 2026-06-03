const express = require('express');
const Goal    = require('../models/Goal');
const User    = require('../models/User');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 3, pro: Infinity, enterprise: Infinity };

const router = express.Router();
router.use(authMiddleware);

/* ── LIST ── */
router.get('/', async (req, res) => {
  try {
    const goals = await Goal.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json(goals.map(formatGoal));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const user  = await User.findById(req.userId);
    const tier  = user?.subscription_tier || 'free';
    const limit = PLAN_LIMITS[tier];

    if (isFinite(limit)) {
      const count = await Goal.countDocuments({ user_id: req.userId });
      if (count >= limit) {
        return res.status(403).json({
          message: `Free plan is limited to ${limit} goals. Upgrade to Pro for unlimited goals.`,
          upgradeRequired: true,
        });
      }
    }

    const { title, description, target, current, unit, deadline, category, color } = req.body;
    const goal = new Goal({ user_id: req.userId, title, description, target, current, unit, deadline, category, color });
    await goal.save();
    res.status(201).json(formatGoal(goal));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ── */
router.put('/:id', async (req, res) => {
  try {
    const goal = await Goal.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!goal) return res.status(404).json({ message: 'Goal not found' });
    res.json(formatGoal(goal));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const goal = await Goal.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!goal) return res.status(404).json({ message: 'Goal not found' });
    res.json({ message: 'Goal deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

function formatGoal(g) {
  return {
    id:          g._id,
    user_id:     g.user_id,
    title:       g.title,
    description: g.description,
    target:      g.target,
    current:     g.current,
    unit:        g.unit,
    deadline:    g.deadline,
    category:    g.category,
    color:       g.color,
    created_at:  g.created_at,
    updated_at:  g.updated_at,
  };
}

module.exports = router;
