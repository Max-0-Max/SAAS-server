const mongoose = require('mongoose');

/**
 * One entry per meaningful change to a task. Kept intentionally simple —
 * `action` is a short machine-readable type, `details` holds whatever
 * before/after values are relevant to that action type, and `meta` is a
 * denormalized snapshot (task title at the time) so log entries still read
 * sensibly even after the task itself is edited or deleted.
 */
const ActivityLogSchema = new mongoose.Schema({
  task_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  actor_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: {
    type: String,
    enum: ['created', 'status_changed', 'assigned', 'unassigned', 'reassigned', 'due_date_changed', 'edited', 'deleted'],
    required: true,
  },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { from: 'todo', to: 'done' }
  meta:    { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { task_title: '...' } — survives task deletion/edits
  created_at: { type: Date, default: Date.now },
});

ActivityLogSchema.index({ task_id: 1, created_at: -1 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema, 'ActivityLog');
