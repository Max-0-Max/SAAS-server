const mongoose = require('mongoose');

const NotificationPrefsSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Email-based
  email_tasks:     { type: Boolean, default: true },   // task assigned to me
  email_reminders: { type: Boolean, default: true },   // due date reminders
  email_weekly:    { type: Boolean, default: false },  // Monday weekly digest

  // In-app / push
  push_tasks:      { type: Boolean, default: true },   // task updates
  push_reminders:  { type: Boolean, default: true },   // habit reminders

}, { timestamps: true });

module.exports = mongoose.model('NotificationPrefs', NotificationPrefsSchema, 'NotificationPrefs');
