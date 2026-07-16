const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  // Present only for accounts created/linked via "Sign in with Google"
  googleId: { type: String, default: null, unique: true, sparse: true },
  avatar_url: String,
  // 2FA (TOTP)
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String, default: null },      // set once enabled
  twoFactorTempSecret: { type: String, default: null },   // set during setup, before confirmed
  backupCodes: { type: [String], default: [] },           // bcrypt-hashed, single-use
  role: { type: String, default: '' },
  timezone: { type: String, default: 'UTC' },
  language: { type: String, default: 'English (US)' },
  date_format: { type: String, default: 'MM/DD/YYYY' },
  subscription_tier: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  stripeCustomerId: { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },
  // Password reset via OTP
  resetOtp:       { type: String, default: null },
  resetOtpExpiry: { type: Date,   default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', UserSchema, 'Users');
