const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
require('dotenv').config();

const app = express();
connectDB();

// Start notification cron (no-op if SMTP not configured)
const { startCron } = require('./jobs/notificationJob');
startCron();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (e.g. curl, Postman) or matching origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
