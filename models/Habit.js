const mongoose = require('mongoose');

const HabitSchema = new mongoose.Schema({
  user_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true },
  description:    { type: String, default: '' },
  color:          { type: String, default: '#6C47FF' },
  frequency:      { type: String, enum: ['daily', 'weekly'], default: 'daily' },
  streak:         { type: Number, default: 0 },
  completedDates: { type: [String], default: [] }, // ISO date strings e.g. '2025-01-01'
  created_at:     { type: Date, default: Date.now },
  updated_at:     { type: Date, default: Date.now },
});

module.exports = mongoose.model('Habit', HabitSchema, 'Habits');
