const ActivityLog = require('../models/ActivityLog');


async function logActivity({ entityType = 'task', taskId, projectId, actorId, ownerId, assigneeId, action, details, title }) {
  try {
    await ActivityLog.create({
      entity_type: entityType,
      task_id: entityType === 'task' ? taskId : undefined,
      project_id: projectId,
      actor_id: actorId,
      owner_id: ownerId,
      assignee_id: assigneeId || null,
      action,
      details: details || {},
      meta: { title },
    });
  } catch (err) {
    console.error('logActivity failed:', err.message);
  }
}

module.exports = { logActivity };
