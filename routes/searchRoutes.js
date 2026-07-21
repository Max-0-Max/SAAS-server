const express = require('express');
const Task = require('../models/Task');
const Project = require('../models/Project');
const Note = require('../models/Note');
const Goal = require('../models/Goal');
const Habit = require('../models/Habit');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseDateQuery(raw) {
  const q = raw.toLowerCase().trim();

  const iso = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { year: +iso[1], month: +iso[2] - 1, day: +iso[3] };

  const us = q.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (us) return { month: +us[1] - 1, day: +us[2], year: +us[3] };

  const tokens = q.split(/[\s,]+/).filter(Boolean);
  let month = null, day = null, year = null;

  for (const tok of tokens) {
    const clean = tok.replace(/(st|nd|rd|th)$/, '');
    if (/^\d{4}$/.test(clean)) { year = +clean; continue; }
    if (/^\d{1,2}$/.test(clean)) {
      const n = +clean;
      if (n >= 1 && n <= 31) { day = n; continue; }
    }
    const monthIdx = MONTHS.indexOf(tok);
    if (monthIdx !== -1) { month = monthIdx; continue; }
    const abbrIdx = MONTHS.findIndex(m => m.slice(0, 3) === tok.slice(0, 3));
    if (abbrIdx !== -1 && tok.length >= 3 && tok.length <= 4) { month = abbrIdx; continue; }
  }

  if (month === null && day === null && year === null) return null;
  return { month, day, year };
}

function dateMatches(dateVal, parsed) {
  if (!dateVal || !parsed) return false;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return false;
  if (parsed.year !== null && parsed.year !== undefined && d.getFullYear() !== parsed.year) return false;
  if (parsed.month !== null && parsed.month !== undefined && d.getMonth() !== parsed.month) return false;
  if (parsed.day !== null && parsed.day !== undefined && d.getDate() !== parsed.day) return false;
  return true;
}

function textMatches(query, ...fields) {
  const q = query.toLowerCase();
  return fields.some(f => f && String(f).toLowerCase().includes(q));
}

/* ── GET /api/search?q=... ──
   Searches across tasks, projects, notes, goals, and habits at once.
   Matches plain text (case-insensitive substring) OR a date-like query
   against the most relevant date field for that entity type (task due
   date, goal deadline, created date otherwise). A result can match on
   either or both. ── */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ tasks: [], projects: [], notes: [], goals: [], habits: [], total: 0 });

    const datedQuery = parseDateQuery(q);

    const [tasks, projects, notes, goals, habits] = await Promise.all([
      Task.find({ $or: [{ user_id: req.userId }, { assigned_to: req.userId }] }).sort({ created_at: -1 }).limit(500),
      Project.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(500),
      Note.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(500),
      Goal.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(500),
      Habit.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(500),
    ]);

    const matchedTasks = tasks.filter(t =>
      textMatches(q, t.title, t.description) || dateMatches(t.due_date, datedQuery)
    ).slice(0, 20).map(t => ({
      id: t._id, title: t.title, snippet: t.description || null,
      due_date: t.due_date || null, status: t.status, project_id: t.project_id,
    }));

    const matchedProjects = projects.filter(p =>
      textMatches(q, p.name, p.description) || dateMatches(p.created_at, datedQuery)
    ).slice(0, 20).map(p => ({
      id: p._id, title: p.name, snippet: p.description || null, created_at: p.created_at,
    }));

    const matchedNotes = notes.filter(n =>
      textMatches(q, n.title, n.content) || dateMatches(n.created_at, datedQuery)
    ).slice(0, 20).map(n => ({
      id: n._id, title: n.title, snippet: n.content ? n.content.slice(0, 140) : null, created_at: n.created_at,
    }));

    const matchedGoals = goals.filter(g =>
      textMatches(q, g.title, g.description) || dateMatches(g.deadline, datedQuery) || dateMatches(g.created_at, datedQuery)
    ).slice(0, 20).map(g => ({
      id: g._id, title: g.title, snippet: g.description || null, deadline: g.deadline || null,
    }));

    const matchedHabits = habits.filter(h =>
      textMatches(q, h.name, h.description) || dateMatches(h.created_at, datedQuery)
    ).slice(0, 20).map(h => ({
      id: h._id, title: h.name, snippet: h.description || null,
    }));

    res.json({
      tasks: matchedTasks,
      projects: matchedProjects,
      notes: matchedNotes,
      goals: matchedGoals,
      habits: matchedHabits,
      total: matchedTasks.length + matchedProjects.length + matchedNotes.length + matchedGoals.length + matchedHabits.length,
    });
  } catch (err) {
    console.error('GET /search', err);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
