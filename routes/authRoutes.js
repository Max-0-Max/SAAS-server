const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { sendEmail } = require('../jobs/notificationJob');
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

/* ══════════════════════════════════════════════════════════════
   FORGOT PASSWORD — OTP via email
   POST /api/auth/forgot-password   { email }
   POST /api/auth/verify-otp        { email, otp }
   POST /api/auth/reset-password    { email, otp, newPassword }
══════════════════════════════════════════════════════════════ */

/** Generate a 6-digit OTP */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* Step 1 — send OTP to email */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const user = await User.findOne({ email });
    // Always respond 200 so we don't leak whether an account exists
    if (!user) return res.json({ message: 'If that email exists, an OTP has been sent.' });

    const otp = generateOtp();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.resetOtp = otp;
    user.resetOtpExpiry = expiry;
    await user.save();

    await sendEmail({
      to: email,
      subject: 'Your Nexus password reset code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:linear-gradient(135deg,#6C47FF,#A855F7);padding:28px 32px;border-radius:16px 16px 0 0;">
            <h1 style="margin:0;color:white;font-size:22px;">✦ Nexus</h1>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 16px 16px;border:1px solid #e8e7f0;border-top:none;">
            <h2 style="margin:0 0 12px;color:#1a1a2e;">Password Reset</h2>
            <p style="color:#555;margin:0 0 20px;">
              Use the code below to reset your Nexus password. It expires in <strong>10 minutes</strong>.
            </p>
            <div style="background:#F4F4F8;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;">
              <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#6C47FF;">${otp}</span>
            </div>
            <p style="color:#aaa;font-size:12px;margin:0;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    res.json({ message: 'If that email exists, an OTP has been sent.' });
  } catch (err) {
    console.error('POST /forgot-password', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* Step 2 — verify OTP (optional pre-check before setting new password) */
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  try {
    const user = await User.findOne({ email });
    if (!user || user.resetOtp !== otp || !user.resetOtpExpiry || user.resetOtpExpiry < new Date())
      return res.status(400).json({ message: 'Invalid or expired OTP' });

    res.json({ message: 'OTP verified' });
  } catch (err) {
    console.error('POST /verify-otp', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* Step 3 — set new password */
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ message: 'Email, OTP, and new password are required' });
  if (newPassword.length < 8)
    return res.status(400).json({ message: 'Password must be at least 8 characters' });

  try {
    const user = await User.findOne({ email });
    if (!user || user.resetOtp !== otp || !user.resetOtpExpiry || user.resetOtpExpiry < new Date())
      return res.status(400).json({ message: 'Invalid or expired OTP' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetOtp = null;
    user.resetOtpExpiry = null;
    user.updated_at = new Date();
    await user.save();

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('POST /reset-password', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
