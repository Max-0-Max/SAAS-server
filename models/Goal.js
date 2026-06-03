const mongoose = require('mongoose');

const GoalSchema = new mongoose.Schema({
  user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  target:      { type: Number, required: true },
  current:     { type: Number, default: 0 },
  unit:        { type: String, default: '' },
  deadline:    { type: Date },
  category:    { type: String, default: 'Personal' },
  color:       { type: String, default: '#6C47FF' },
  created_at:  { type: Date, default: Date.now },
  updated_at:  { type: Date, default: Date.now },
});

module.exports = mongoose.model('Goal', GoalSchema, 'Goals');
