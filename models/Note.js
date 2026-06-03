const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:      { type: String, required: true },
  content:    { type: String, default: '' },
  color:      { type: String, default: '#FFFFFF' },
  pinned:     { type: Boolean, default: false },
  tags:       { type: [String], default: [] },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Note', NoteSchema, 'Notes');
