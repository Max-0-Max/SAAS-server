const mongoose = require('mongoose');


const ActivityLogSchema = new mongoose.Schema({
  entity_type: { type: String, enum: ['task', 'project'], default: 'task' },
  task_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Task' }, // required for entity_type: 'task'
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  actor_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: {
    type: String,
    enum: [
      'created', 'status_changed', 'assigned', 'unassigned', 'reassigned', 'due_date_changed', 'edited', 'deleted',
      'project_created', 'project_edited', 'project_deleted',
    ],
    required: true,
  },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { from: 'todo', to: 'done' }
  meta:    { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { task_title: '...' } — survives task deletion/edits
  created_at: { type: Date, default: Date.now },
});

ActivityLogSchema.index({ task_id: 1, created_at: -1 });
ActivityLogSchema.index({ project_id: 1, created_at: -1 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema, 'ActivityLog');
