const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  status: { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  due_date: { type: Date },
  position: { type: Number, default: 0 },
  // The team member this task is assigned to (must be an active member of the
  // task owner's workspace). Null/absent means unassigned.
  assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Task', TaskSchema, 'Tasks');
