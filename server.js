const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
require('dotenv').config();

const app = express();
connectDB();

const { startCron } = require('./jobs/notificationJob');
if (!process.env.VERCEL) {
  startCron();
} else {
  console.log('[NotificationJob] Running on Vercel — use /api/cron/daily-digest and /api/cron/deadline-reminders with an external scheduler instead of node-cron.');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (e.g. curl, Postman) or matching origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
 
    console.warn(`[CORS] Blocked request from disallowed origin: ${origin}`);
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ⚠️ Webhook needs raw body — register BEFORE express.json()
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/billingRoutes').webhook);

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth',          require('./routes/authRoutes'));
app.use('/api/projects',      require('./routes/projectRoutes'));
app.use('/api/tasks',         require('./routes/taskRoutes'));
app.use('/api/goals',         require('./routes/goalRoutes'));
app.use('/api/habits',        require('./routes/habitRoutes'));
app.use('/api/notes',         require('./routes/noteRoutes'));
app.use('/api/billing',       require('./routes/billingRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/activity',      require('./routes/activityRoutes'));
app.use('/api/cron',          require('./routes/cronRoutes'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.use((err, req, res, next) => {
  console.error(`[Unhandled error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.statusCode || 500).json({ message: err.message || 'Internal server error' });
});

module.exports = app;
