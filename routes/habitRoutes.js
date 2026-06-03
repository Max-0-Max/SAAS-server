const express = require('express');
const Habit   = require('../models/Habit');
const User    = require('../models/User');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 5, pro: Infinity, enterprise: Infinity };

const router = express.Router();
router.use(authMiddleware);

/* ── LIST ── */
router.get('/', async (req, res) => {
  try {
    const habits = await Habit.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json(habits.map(formatHabit));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const user  = await User.findById(req.userId);
    const tier  = user?.subscription_tier || 'free';
    const limit = PLAN_LIMITS[tier];

    if (isFinite(limit)) {
      const count = await Habit.countDocuments({ user_id: req.userId });
      if (count >= limit) {
        return res.status(403).json({
          message: `Free plan is limited to ${limit} habits. Upgrade to Pro for unlimited habits.`,
          upgradeRequired: true,
        });
      }
    }

    const { name, description, color, frequency } = req.body;
    const habit = new Habit({ user_id: req.userId, name, description, color, frequency });
    await habit.save();
    res.status(201).json(formatHabit(habit));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── TOGGLE DATE (check in / out) ── */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { date } = req.body; // ISO date string e.g. '2025-01-15'
    const habit = await Habit.findOne({ _id: req.params.id, user_id: req.userId });
    if (!habit) return res.status(404).json({ message: 'Habit not found' });

    const done = habit.completedDates.includes(date);
    if (done) {
      habit.completedDates = habit.completedDates.filter(d => d !== date);
      habit.streak = Math.max(0, habit.streak - 1);
    } else {
      habit.completedDates.push(date);
      habit.streak += 1;
    }
    habit.updated_at = new Date();
    await habit.save();
    res.json(formatHabit(habit));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ── */
router.put('/:id', async (req, res) => {
  try {
    const habit = await Habit.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!habit) return res.status(404).json({ message: 'Habit not found' });
    res.json(formatHabit(habit));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const habit = await Habit.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!habit) return res.status(404).json({ message: 'Habit not found' });
    res.json({ message: 'Habit deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

function formatHabit(h) {
  return {
    id:             h._id,
    user_id:        h.user_id,
    name:           h.name,
    description:    h.description,
    color:          h.color,
    frequency:      h.frequency,
    streak:         h.streak,
    completedDates: h.completedDates,
    created_at:     h.created_at,
    updated_at:     h.updated_at,
  };
}

module.exports = router;
