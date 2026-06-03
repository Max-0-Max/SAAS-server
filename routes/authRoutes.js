const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

/* ── Multer: avatar uploads ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.userId}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, GIF allowed'));
  },
});

/* ── Helper: shape user for API response ── */
function formatUser(user) {
  return {
    id: user._id,
    full_name: user.name,
    email: user.email,
    avatar_url: user.avatar_url || null,
    role: user.role || '',
    timezone: user.timezone || 'UTC',
    language: user.language || 'English (US)',
    date_format: user.date_format || 'MM/DD/YYYY',
    subscription_tier: user.subscription_tier || 'free',
    created_at: user.created_at,
  };
}

/* ── REGISTER ── */
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    if (await User.findOne({ email }))
      return res.status(400).json({ message: 'Email already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server Error' });
  }
});

/* ── LOGIN ── */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ── GET /me ── */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(formatUser(user));
  } catch (err) {
    res.status(500).json({ message: 'Server Error' });
  }
});

/* ── PUT /me — update profile fields ── */
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { full_name, role, timezone, language, date_format } = req.body;
    const updates = { updated_at: new Date() };
    if (full_name !== undefined) updates.name = full_name;
    if (role !== undefined) updates.role = role;
    if (timezone !== undefined) updates.timezone = timezone;
    if (language !== undefined) updates.language = language;
    if (date_format !== undefined) updates.date_format = date_format;

    const user = await User.findByIdAndUpdate(req.userId, updates, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(formatUser(user));
  } catch (err) {
    res.status(500).json({ message: 'Server Error' });
  }
});

/* ── POST /me/avatar — upload profile photo ── */
router.post('/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const serverBaseUrl = process.env.SERVER_BASE_URL || 'http://localhost:5000';
    const avatar_url = `${serverBaseUrl}/uploads/avatars/${req.file.filename}`;

    const user = await User.findByIdAndUpdate(
      req.userId,
      { avatar_url, updated_at: new Date() },
      { new: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(formatUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message || 'Upload failed' });
  }
});

/* ── PUT /me/password — change password ── */
router.put('/me/password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ message: 'Both current and new password are required' });
    if (new_password.length < 8)
      return res.status(400).json({ message: 'New password must be at least 8 characters' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await bcrypt.compare(current_password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });

    user.password = await bcrypt.hash(new_password, 10);
    user.updated_at = new Date();
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server Error' });
  }
});

/* ── DELETE /me — delete account ── */
router.delete('/me', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.userId);
    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
