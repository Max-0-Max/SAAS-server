const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  avatar_url: String,
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
