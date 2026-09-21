import { one, run } from '../db/database.js';
import { newId } from '../lib/ids.js';
import { sendToUser } from './hub.js';

/** Insert a notification once (dedupe_key) and push it live if the person is connected. */
export function notify({ userId, kind, severity = 'info', title, body = null, vehicleId = null, dedupeKey = null }) {
  if (!userId) return null;
  const id = newId('ntf');
  const res = run(
    `INSERT OR IGNORE INTO notifications (id, user_id, kind, severity, title, body, vehicle_id, dedupe_key) VALUES (?,?,?,?,?,?,?,?)`,
    [id, userId, kind, severity, title, body, vehicleId, dedupeKey],
  );
  if (!res.changes) return null;
  const row = one('SELECT * FROM notifications WHERE id = ?', [id]);
  sendToUser(userId, { type: 'NOTIFICATION', notification: row });
  return row;
}
