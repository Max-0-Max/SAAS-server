const express = require('express');
const Task    = require('../models/Task');
const User    = require('../models/User');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 50, pro: Infinity, enterprise: Infinity }; // 50 tasks per project

const router = express.Router();
router.use(authMiddleware);

/* ── LIST (optionally filter by project_id) ── */
router.get('/', async (req, res) => {
  try {
    const filter = { user_id: req.userId };
    if (req.query.project_id) filter.project_id = req.query.project_id;
    const tasks = await Task.find(filter).sort({ position: 1, created_at: -1 });
    res.json(tasks.map(formatTask));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, due_date, position } = req.body;

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

    const task = new Task({ user_id: req.userId, project_id, title, description, status, priority, due_date, position });
    await task.save();
    res.status(201).json(formatTask(task));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ── */
router.put('/:id', async (req, res) => {
  try {
    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json(formatTask(task));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json({ message: 'Task deleted' });
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
    created_at:  t.created_at,
    updated_at:  t.updated_at,
  };
}

module.exports = router;
