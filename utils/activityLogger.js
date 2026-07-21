const ActivityLog = require('../models/ActivityLog');

/**
 * Record an activity entry. Best-effort — a logging failure should never
 * block the actual operation it's describing. Callers should `await` this
 * (not fire-and-forget) so it can't get dropped by a serverless platform
 * freezing the function right after the response is sent.
 *
 * entityType: 'task' | 'project' — task_id is required for 'task' entries,
 * omitted for 'project'-level entries (e.g. project created/deleted).
 */
async function logActivity({ entityType = 'task', taskId, projectId, actorId, action, details, title }) {
  try {
    await ActivityLog.create({
      entity_type: entityType,
      task_id: entityType === 'task' ? taskId : undefined,
      project_id: projectId,
      actor_id: actorId,
      action,
      details: details || {},
      meta: { title },
    });
  } catch (err) {
    console.error('logActivity failed:', err.message);
  }
}

module.exports = { logActivity };