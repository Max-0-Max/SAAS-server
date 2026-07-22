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
    // Quietly deny (no CORS headers) rather than throwing — throwing here
    // has no error handler to catch it and crashes the whole serverless
    // function instead of just failing the one cross-origin request.
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
app.use('/api/comments',      require('./routes/commentRoutes'));
app.use('/api/activity',      require('./routes/activityRoutes'));
app.use('/api/search',        require('./routes/searchRoutes'));
app.use('/api/cron',          require('./routes/cronRoutes'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Global error handler — must be registered last. Without this, any error
// thrown or passed to next(err) anywhere above (including inside the cors
// middleware, multer, JSON parsing, etc.) has nowhere to go, and on Vercel
// that means the entire function invocation fails instead of returning a
// normal error response.
app.use((err, req, res, next) => {
  console.error(`[Unhandled error] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.statusCode || 500).json({ message: err.message || 'Internal server error' });
});

module.exports = app;
