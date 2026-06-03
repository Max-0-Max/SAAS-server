const express = require('express');
const Project = require('../models/Project');
const Task = require('../models/Task');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const PLAN_LIMITS = { free: 5, pro: Infinity, enterprise: Infinity };

const router = express.Router();
router.use(authMiddleware);

/* ── LIST ── */
router.get('/', async (req, res) => {
  try {
    const projects = await Project.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json(projects.map(formatProject));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── CREATE ── */
router.post('/', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const tier = user?.subscription_tier || 'free';
    const limit = PLAN_LIMITS[tier];

    if (isFinite(limit)) {
      const count = await Project.countDocuments({ user_id: req.userId });
      if (count >= limit) {
        return res.status(403).json({
          message: `Free plan is limited to ${limit} projects. Upgrade to Pro for unlimited projects.`,
          upgradeRequired: true,
        });
      }
    }

    const { name, description, color } = req.body;
    const project = new Project({ user_id: req.userId, name, description, color });
    await project.save();
    res.status(201).json(formatProject(project));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── UPDATE ── */
router.put('/:id', async (req, res) => {
  try {
    const project = await Project.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(formatProject(project));
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

/* ── DELETE ── */
router.delete('/:id', async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!project) return res.status(404).json({ message: 'Project not found' });
    // Cascade delete tasks
    await Task.deleteMany({ project_id: req.params.id });
    res.json({ message: 'Project deleted' });
  } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

function formatProject(p) {
  return {
    id: p._id,
    user_id: p.user_id,
    name: p.name,
    description: p.description,
    color: p.color,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

module.exports = router;
