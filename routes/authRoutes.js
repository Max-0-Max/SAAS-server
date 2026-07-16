const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { sendEmail } = require('../jobs/notificationJob');
require('dotenv').config();

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
    google_linked: !!user.googleId,
    has_password: !!user.password,
    two_factor_enabled: !!user.twoFactorEnabled,
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

    if (!user.password) {
      return res.status(400).json({ message: 'This account uses Google Sign-In. Please continue with Google.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    if (user.twoFactorEnabled) {
      const pendingToken = jwt.sign({ id: user._id, twofa_pending: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
      return res.json({ requires_2fa: true, pending_token: pendingToken });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ── GOOGLE SIGN-IN / SIGN-UP ──
   Frontend sends the Google ID token (the `credential` returned by
   Google Identity Services) in the body. We verify it server-side,
   then either log the matching user in or create a new one. ── */
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ message: 'Missing Google credential' });
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('POST /auth/google: GOOGLE_CLIENT_ID is not configured');
    return res.status(500).json({ message: 'Google Sign-In is not configured on the server' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ message: 'Invalid Google credential' });
    }

    const { sub: googleId, email, name, picture, email_verified } = payload;
    if (!email_verified) {
      return res.status(400).json({ message: 'Google email is not verified' });
    }

    // Match by googleId first, then fall back to email so an existing
    // password-based account gets linked instead of duplicated.
    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = googleId;
        if (!user.avatar_url && picture) user.avatar_url = picture;
        user.updated_at = new Date();
        await user.save();
      }
    }

    if (!user) {
      user = new User({
        name: name || email.split('@')[0],
        email,
        googleId,
        avatar_url: picture || undefined,
      });
      await user.save();
    }

    if (user.twoFactorEnabled) {
      const pendingToken = jwt.sign({ id: user._id, twofa_pending: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
      return res.json({ requires_2fa: true, pending_token: pendingToken });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    console.error('POST /auth/google', err);
    res.status(401).json({ message: 'Google Sign-In failed. Please try again.' });
  }
});

/* ── LINK GOOGLE — connect Google to an already-logged-in account ──
   POST /api/auth/link-google   { credential }   (requires auth) ── */
router.post('/link-google', authMiddleware, async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ message: 'Missing Google credential' });
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('POST /auth/link-google: GOOGLE_CLIENT_ID is not configured');
    return res.status(500).json({ message: 'Google Sign-In is not configured on the server' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) {
      return res.status(400).json({ message: 'Invalid Google credential' });
    }

    const { sub: googleId, email, picture } = payload;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (email.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(400).json({ message: `That Google account is signed in as ${email}, which doesn't match your account email.` });
    }

    const existing = await User.findOne({ googleId });
    if (existing && String(existing._id) !== String(user._id)) {
      return res.status(400).json({ message: 'That Google account is already linked to a different Nexus account.' });
    }

    user.googleId = googleId;
    if (!user.avatar_url && picture) user.avatar_url = picture;
    user.updated_at = new Date();
    await user.save();

    res.json(formatUser(user));
  } catch (err) {
    console.error('POST /auth/link-google', err);
    res.status(401).json({ message: 'Failed to link Google account. Please try again.' });
  }
});

/* ── UNLINK GOOGLE — disconnect Google from the account ──
   DELETE /api/auth/google   (requires auth)
   Blocked if the account has no password, since that would lock the
   user out entirely — they must set a password first. ── */
router.delete('/google', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!user.googleId) {
      return res.status(400).json({ message: 'No Google account is linked.' });
    }
    if (!user.password) {
      return res.status(400).json({ message: 'Set a password first so you don\'t get locked out, then disconnect Google.' });
    }

    user.googleId = null;
    user.updated_at = new Date();
    await user.save();

    res.json(formatUser(user));
  } catch (err) {
    console.error('DELETE /auth/google', err);
    res.status(500).json({ message: 'Failed to disconnect Google account.' });
  }
});

/* ── 2FA: SETUP — generate a secret + QR code (not yet enabled) ──
   POST /api/auth/2fa/setup   (requires auth) ── */
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.twoFactorEnabled) return res.status(400).json({ message: '2FA is already enabled' });

    const secret = authenticator.generateSecret();
    user.twoFactorTempSecret = secret;
    await user.save();

    const otpauth = authenticator.keyuri(user.email, 'Nexus', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    res.json({ qr_code: qrCodeDataUrl, secret });
  } catch (err) {
    console.error('POST /auth/2fa/setup', err);
    res.status(500).json({ message: 'Failed to start 2FA setup' });
  }
});

/* ── 2FA: VERIFY SETUP — confirm the code from the authenticator app,
   turn 2FA on, and hand back one-time backup codes ──
   POST /api/auth/2fa/verify-setup   { code }   (requires auth) ── */
router.post('/2fa/verify-setup', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.twoFactorTempSecret) return res.status(400).json({ message: 'Start 2FA setup first' });
    if (!code) return res.status(400).json({ message: 'Verification code is required' });

    const isValid = authenticator.verify({ token: code, secret: user.twoFactorTempSecret });
    if (!isValid) return res.status(400).json({ message: 'Invalid code. Check your app and try again.' });

    // Generate 8 human-friendly single-use backup codes; store only their hashes.
    const plainBackupCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-')
    );
    const hashedBackupCodes = await Promise.all(plainBackupCodes.map(c => bcrypt.hash(c, 10)));

    user.twoFactorSecret = user.twoFactorTempSecret;
    user.twoFactorTempSecret = null;
    user.twoFactorEnabled = true;
    user.backupCodes = hashedBackupCodes;
    user.updated_at = new Date();
    await user.save();

    res.json({ enabled: true, backup_codes: plainBackupCodes });
  } catch (err) {
    console.error('POST /auth/2fa/verify-setup', err);
    res.status(500).json({ message: 'Failed to verify 2FA code' });
  }
});

/* ── 2FA: DISABLE ──
   POST /api/auth/2fa/disable   { password, code }   (requires auth)
   Requires proof of ownership: current password (if the account has one)
   PLUS a valid 2FA code or backup code, so an attacker with just a
   stolen session can't turn protection off. ── */
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { password, code } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.twoFactorEnabled) return res.status(400).json({ message: '2FA is not enabled' });

    if (user.password) {
      if (!password) return res.status(400).json({ message: 'Password is required to disable 2FA' });
      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) return res.status(400).json({ message: 'Incorrect password' });
    }

    if (!code) return res.status(400).json({ message: '2FA code is required to disable 2FA' });
    const codeOk = authenticator.verify({ token: code, secret: user.twoFactorSecret });
    let backupUsed = false;
    if (!codeOk) {
      for (const hashed of user.backupCodes) {
        if (await bcrypt.compare(code, hashed)) { backupUsed = true; break; }
      }
      if (!backupUsed) return res.status(400).json({ message: 'Invalid 2FA code' });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = null;
    user.twoFactorTempSecret = null;
    user.backupCodes = [];
    user.updated_at = new Date();
    await user.save();

    res.json(formatUser(user));
  } catch (err) {
    console.error('POST /auth/2fa/disable', err);
    res.status(500).json({ message: 'Failed to disable 2FA' });
  }
});

/* ── 2FA: LOGIN VERIFY — second step of login when 2FA is enabled ──
   POST /api/auth/2fa/login-verify   { pending_token, code }
   (no authMiddleware — the pending_token itself is the credential) ── */
router.post('/2fa/login-verify', async (req, res) => {
  try {
    const { pending_token, code } = req.body;
    if (!pending_token || !code) return res.status(400).json({ message: 'Missing pending token or code' });

    let decoded;
    try {
      decoded = jwt.verify(pending_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Login session expired. Please log in again.' });
    }
    if (!decoded.twofa_pending) return res.status(400).json({ message: 'Invalid pending token' });

    const user = await User.findById(decoded.id);
    if (!user || !user.twoFactorEnabled) return res.status(400).json({ message: 'Invalid request' });

    const isValid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
    let usedBackupIndex = -1;
    if (!isValid) {
      for (let i = 0; i < user.backupCodes.length; i++) {
        if (await bcrypt.compare(code, user.backupCodes[i])) { usedBackupIndex = i; break; }
      }
      if (usedBackupIndex === -1) return res.status(400).json({ message: 'Invalid code' });
      // Backup codes are single-use — remove it once spent.
      user.backupCodes.splice(usedBackupIndex, 1);
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: formatUser(user), used_backup_code: usedBackupIndex !== -1 });
  } catch (err) {
    console.error('POST /auth/2fa/login-verify', err);
    res.status(500).json({ message: 'Failed to verify 2FA code' });
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
    if (!new_password)
      return res.status(400).json({ message: 'New password is required' });
    if (new_password.length < 8)
      return res.status(400).json({ message: 'New password must be at least 8 characters' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.password) {
      // Normal case: must prove you know the current password
      if (!current_password) return res.status(400).json({ message: 'Current password is required' });
      const isMatch = await bcrypt.compare(current_password, user.password);
      if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });
    }
    // else: Google-only account with no password yet — setting the first one requires no current_password

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

    // Use $set directly so the fields are written even on pre-existing documents
    await User.updateOne({ _id: user._id }, { $set: { resetOtp: otp, resetOtpExpiry: expiry } });

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
    // .lean() bypasses Mongoose model cache and reads raw document from DB
    const user = await User.findOne({ email }).lean();
    if (!user || user.resetOtp !== otp || !user.resetOtpExpiry || new Date(user.resetOtpExpiry) < new Date())
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
    // .lean() reads raw DB document — bypasses any Mongoose field caching
    const user = await User.findOne({ email }).lean();
    if (!user || user.resetOtp !== otp || !user.resetOtpExpiry || new Date(user.resetOtpExpiry) < new Date())
      return res.status(400).json({ message: 'Invalid or expired OTP' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword, updated_at: new Date() }, $unset: { resetOtp: '', resetOtpExpiry: '' } }
    );

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('POST /reset-password', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
