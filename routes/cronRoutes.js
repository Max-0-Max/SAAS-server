const express = require('express');
const { runDailyChecks, checkDeadlineReminders } = require('../jobs/notificationJob');

const router = express.Router();

/**
 * These routes exist because node-cron's in-process scheduling doesn't work
 * on serverless platforms (Vercel/Netlify) — there's no long-running process
 * for it to tick in. Instead, an external scheduler (or Vercel's own Cron
 * Jobs feature) hits these endpoints on a schedule.
 *
 * Auth: expects the shared secret either as `Authorization: Bearer <secret>`
 * (this is exactly the header Vercel Cron sends automatically) or as a
 * `?secret=` query param (for schedulers that can't set custom headers).
 */
function verifyCronSecret(req, res, next) {
  if (!process.env.CRON_SECRET) {
    console.error('[cron] CRON_SECRET is not set — refusing all cron requests.');
    return res.status(500).json({ message: 'Cron endpoint not configured' });
  }
  const header = req.headers['authorization'];
  const provided = (header && header.replace(/^Bearer\s+/i, '')) || req.query.secret;
  if (provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

// Suggested schedule: once daily (fits Vercel Hobby's cron limit).
// vercel.json -> { "path": "/api/cron/daily-digest", "schedule": "0 8 * * *" }
router.get('/daily-digest', verifyCronSecret, async (req, res) => {
  try {
    await runDailyChecks();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] daily-digest failed:', err);
    res.status(500).json({ ok: false });
  }
});

// Suggested schedule: every 5 minutes. Vercel Hobby can't do this natively —
// point a free external scheduler (e.g. cron-job.org) at this URL instead:
//   https://<your-domain>/api/cron/deadline-reminders?secret=<CRON_SECRET>
router.get('/deadline-reminders', verifyCronSecret, async (req, res) => {
  try {
    await checkDeadlineReminders();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] deadline-reminders failed:', err);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
