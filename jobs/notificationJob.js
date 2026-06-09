/**
 * notificationJob.js
 *
 * - sendEmail()  : reusable Nodemailer helper used by routes too
 * - runDailyChecks() : checks all users' data and fires emails based on prefs
 * - startCron()  : schedules runDailyChecks() via node-cron
 *
 * Schedule:
 *   • Every day at 08:00 UTC  → due-date reminders + habit reminders
 *   • Every Monday at 08:00 UTC → weekly digest (on top of daily)
 *
 * Add to your .env:
 *   SMTP_HOST=smtp.gmail.com        (or any SMTP provider)
 *   SMTP_PORT=587
 *   SMTP_USER=your@gmail.com
 *   SMTP_PASS=your_app_password      (Gmail → App Passwords)
 *   FROM_EMAIL=Nexus <your@gmail.com>
 */

const nodemailer = require('nodemailer');
const cron = require('node-cron');

const User               = require('../models/User');
const Task               = require('../models/Task');
const Habit              = require('../models/Habit');
const Goal               = require('../models/Goal');
const NotificationPrefs  = require('../models/NotificationPrefs');
const TeamMember         = require('../models/TeamMember');

/* ── Mailer ──────────────────────────────────────────────────────────── */

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

/**
 * sendEmail({ to, subject, html, text? })
 * Safe to call even without SMTP configured — just logs in dev.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[Email - DEV ONLY] To: ${to} | Subject: ${subject}`);
    return;
  }
  try {
    const info = await getTransporter().sendMail({
      from:    process.env.FROM_EMAIL || process.env.SMTP_USER,
      to, subject, html,
      text:    text || html.replace(/<[^>]+>/g, ''),
    });
    console.log(`[Email sent] ${to} → ${subject} (${info.messageId})`);
  } catch (err) {
    console.error(`[Email failed] ${to} → ${subject}:`, err.message);
  }
}

/* ── Date helpers ────────────────────────────────────────────────────── */

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  due.setHours(23, 59, 59, 999);
  return due < new Date();
}

function isDueToday(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate).toISOString().split('T')[0] === todayStr();
}

function isDueTomorrow(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate).toISOString().split('T')[0] === tomorrowStr();
}

/* ── Email templates ─────────────────────────────────────────────────── */

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 560px; margin: 0 auto; color: #1a1a2e;
`;

function wrapEmail(title, bodyHtml) {
  return `
    <div style="${baseStyle}">
      <div style="background: linear-gradient(135deg,#6C47FF,#A855F7); padding: 28px 32px; border-radius: 16px 16px 0 0;">
        <h1 style="margin:0; color:white; font-size:22px;">✦ Nexus</h1>
      </div>
      <div style="background: #fff; padding: 32px; border-radius: 0 0 16px 16px; border: 1px solid #e8e7f0; border-top: none;">
        <h2 style="margin:0 0 16px; color:#1a1a2e; font-size:20px;">${title}</h2>
        ${bodyHtml}
        <hr style="margin: 28px 0; border:none; border-top:1px solid #e8e7f0;">
        <p style="font-size:12px; color:#888; margin:0;">
          You received this because your Nexus notification settings have this alert enabled.
          <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}/settings" style="color:#6C47FF;">Manage preferences →</a>
        </p>
      </div>
    </div>
  `;
}

function taskCard(task, badge) {
  const colors = { overdue: '#EF4444', today: '#F59E0B', tomorrow: '#6C47FF' };
  const color = colors[badge] || '#6C47FF';
  const labels = { overdue: 'OVERDUE', today: 'DUE TODAY', tomorrow: 'DUE TOMORROW' };
  return `
    <div style="padding:14px 16px; background:#f9f9ff; border-left:4px solid ${color}; border-radius:8px; margin-bottom:10px;">
      <span style="font-size:10px; font-weight:700; color:${color}; text-transform:uppercase; letter-spacing:0.5px;">${labels[badge]}</span>
      <p style="margin:4px 0 0; font-weight:600; font-size:15px;">${task.title}</p>
      ${task.due_date ? `<p style="margin:2px 0 0; font-size:12px; color:#888;">Due: ${new Date(task.due_date).toLocaleDateString()}</p>` : ''}
    </div>
  `;
}

/* ── Main job ────────────────────────────────────────────────────────── */

async function runDailyChecks() {
  console.log('[NotificationJob] Starting daily checks…');
  const today = todayStr();
  const isMonday = new Date().getDay() === 1;

  try {
    // Load all users who have ANY email notification pref enabled
    const allPrefs = await NotificationPrefs.find({
      $or: [
        { email_tasks: true },
        { email_reminders: true },
        { email_weekly: true },
      ],
    });

    for (const prefs of allPrefs) {
      try {
        const user = await User.findById(prefs.user_id).select('name email');
        if (!user || !user.email) continue;

        /* ── 1. DUE DATE REMINDERS ── */
        if (prefs.email_reminders) {
          const openTasks = await Task.find({
            user_id: prefs.user_id,
            status: { $ne: 'done' },
            due_date: { $exists: true, $ne: null },
          });

          const overdue   = openTasks.filter(t => isOverdue(t.due_date));
          const dueToday  = openTasks.filter(t => isDueToday(t.due_date));
          const dueTomorrow = openTasks.filter(t => isDueTomorrow(t.due_date));

          if (overdue.length || dueToday.length || dueTomorrow.length) {
            let cardsHtml = '';
            overdue.forEach(t => { cardsHtml += taskCard(t, 'overdue'); });
            dueToday.forEach(t => { cardsHtml += taskCard(t, 'today'); });
            dueTomorrow.forEach(t => { cardsHtml += taskCard(t, 'tomorrow'); });

            const total = overdue.length + dueToday.length + dueTomorrow.length;
            await sendEmail({
              to: user.email,
              subject: `📅 You have ${total} task${total > 1 ? 's' : ''} needing attention — Nexus`,
              html: wrapEmail(
                `Hi ${user.name}, here's your task reminder`,
                `<p style="color:#555; margin:0 0 20px;">These tasks need your attention today:</p>
                 ${cardsHtml}
                 <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}/projects"
                    style="display:inline-block; margin-top:20px; padding:12px 24px; background:#6C47FF; color:white; border-radius:10px; text-decoration:none; font-weight:600;">
                   Open Projects →
                 </a>`
              ),
            });
          }
        }

        /* ── 2. HABIT REMINDERS ── */
        if (prefs.push_reminders) {
          const habits = await Habit.find({ user_id: prefs.user_id });
          const notDoneToday = habits.filter(h => !h.completedDates.includes(today));

          if (notDoneToday.length > 0) {
            const habitList = notDoneToday.map(h =>
              `<li style="margin-bottom:6px;"><strong>${h.name}</strong> — 🔥 ${h.streak}-day streak</li>`
            ).join('');

            await sendEmail({
              to: user.email,
              subject: `🔥 Don't break your streak! ${notDoneToday.length} habit${notDoneToday.length > 1 ? 's' : ''} pending — Nexus`,
              html: wrapEmail(
                `Daily habit check-in`,
                `<p style="color:#555;">You have <strong>${notDoneToday.length} habit${notDoneToday.length > 1 ? 's' : ''}</strong> to complete today:</p>
                 <ul style="padding-left:20px; color:#333; margin:12px 0 20px;">${habitList}</ul>
                 <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}/habits"
                    style="display:inline-block; padding:12px 24px; background:#6C47FF; color:white; border-radius:10px; text-decoration:none; font-weight:600;">
                   Check off habits →
                 </a>`
              ),
            });
          }
        }

        /* ── 3. WEEKLY DIGEST (Mondays only) ── */
        if (prefs.email_weekly && isMonday) {
          const [tasks, habits, goals] = await Promise.all([
            Task.find({ user_id: prefs.user_id }),
            Habit.find({ user_id: prefs.user_id }),
            Goal.find({ user_id: prefs.user_id }),
          ]);

          // Last 7 days
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);

          const doneTasks = tasks.filter(t => t.status === 'done' && new Date(t.updated_at) >= weekAgo).length;
          const activeHabits = habits.filter(h => h.streak > 0).length;
          const topStreak = habits.reduce((max, h) => Math.max(max, h.streak), 0);
          const avgGoal = goals.length
            ? Math.round(goals.reduce((sum, g) => sum + (g.target > 0 ? (g.current / g.target) * 100 : 0), 0) / goals.length)
            : 0;

          const teamMembers = await TeamMember.find({ owner_id: prefs.user_id });

          await sendEmail({
            to: user.email,
            subject: `📊 Your Nexus weekly summary — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
            html: wrapEmail(
              `Your week at a glance, ${user.name}`,
              `<div style="display:grid; gap:12px; margin-bottom:24px;">
                 ${statBox('✅', `${doneTasks}`, 'Tasks completed this week')}
                 ${statBox('🔥', `${topStreak} days`, 'Best habit streak')}
                 ${statBox('💪', `${activeHabits}`, 'Active habits')}
                 ${statBox('🎯', `${avgGoal}%`, 'Average goal progress')}
                 ${teamMembers.length > 0 ? statBox('👥', `${teamMembers.length}`, 'Team members') : ''}
               </div>
               ${goals.length > 0 ? `
                 <h3 style="margin:0 0 12px; font-size:16px;">Goal progress</h3>
                 ${goals.map(g => {
                   const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
                   return `<div style="margin-bottom:12px;">
                     <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                       <span style="font-size:14px;">${g.title}</span>
                       <span style="font-size:14px; font-weight:600; color:${g.color || '#6C47FF'};">${pct}%</span>
                     </div>
                     <div style="height:6px; background:#f0f0f5; border-radius:6px; overflow:hidden;">
                       <div style="height:100%; width:${pct}%; background:${g.color || '#6C47FF'}; border-radius:6px;"></div>
                     </div>
                   </div>`;
                 }).join('')}` : ''}
               <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}/dashboard"
                  style="display:inline-block; margin-top:20px; padding:12px 24px; background:#6C47FF; color:white; border-radius:10px; text-decoration:none; font-weight:600;">
                 Go to dashboard →
               </a>`
            ),
          });
        }

      } catch (userErr) {
        console.error(`[NotificationJob] Error for user ${prefs.user_id}:`, userErr.message);
      }
    }

    /* ── 4. TASK ASSIGNMENT emails ──
       Fire when a task is created with assigned_to set.
       This is handled in taskRoutes.js directly (see comments there).
       We don't re-send them in the cron to avoid duplicates. */

    console.log('[NotificationJob] Daily checks complete.');
  } catch (err) {
    console.error('[NotificationJob] Fatal error:', err);
  }
}

/* ── Cron scheduler ──────────────────────────────────────────────────── */

function startCron() {
  if (!process.env.SMTP_USER) {
    console.log('[NotificationJob] SMTP not configured — email notifications disabled. Set SMTP_USER and SMTP_PASS to enable.');
    return;
  }

  // Run every day at 08:00 UTC
  cron.schedule('0 8 * * *', () => {
    runDailyChecks();
  }, { timezone: 'UTC' });

  console.log('[NotificationJob] Cron scheduled: daily at 08:00 UTC');
}

module.exports = { sendEmail, runDailyChecks, startCron };

/* ── Helper ── */
function statBox(emoji, value, label) {
  return `
    <div style="background:#f9f9ff; border:1px solid #e8e7f0; border-radius:12px; padding:16px 20px; display:flex; align-items:center; gap:16px; margin-bottom:10px;">
      <span style="font-size:24px;">${emoji}</span>
      <div>
        <div style="font-size:22px; font-weight:700; color:#1a1a2e;">${value}</div>
        <div style="font-size:13px; color:#888;">${label}</div>
      </div>
    </div>
  `;
}
