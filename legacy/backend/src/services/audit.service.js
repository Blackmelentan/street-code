import crypto from 'node:crypto';
import { run, query } from '../db/database.js';

/**
 * Record an immutable audit log entry in the system
 */
export function logAuditEvent({ actorId = null, actorRole = 'system', action, targetType, targetId, details = {}, ipAddress = '127.0.0.1' }) {
  const id = crypto.randomUUID();
  const detailsStr = typeof details === 'string' ? details : JSON.stringify(details);

  run(
    `INSERT INTO system_audit_logs 
      (id, actor_id, actor_role, action, target_type, target_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, actorId, actorRole, action, targetType, targetId, detailsStr, ipAddress]
  );

  return { id, action, targetType, targetId, timestamp: new Date().toISOString() };
}

/**
 * Retrieve audit trail with optional filtering
 */
export function getAuditLogs({ limit = 50, action = null, targetType = null } = {}) {
  let sql = 'SELECT * FROM system_audit_logs';
  const params = [];
  const whereClauses = [];

  if (action) {
    whereClauses.push('action = ?');
    params.push(action);
  }
  if (targetType) {
    whereClauses.push('target_type = ?');
    params.push(targetType);
  }

  if (whereClauses.length > 0) {
    sql += ' WHERE ' + whereClauses.join(' AND ');
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return query(sql, params).map(log => ({
    ...log,
    details: (() => {
      try { return JSON.parse(log.details); } catch { return log.details; }
    })()
  }));
}
