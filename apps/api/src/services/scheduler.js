import { all, one, run } from '../db/database.js';
import { computeDocumentHealth } from '../../../../packages/core/src/index.js';
import { vehicleHealth, documentsOf } from './vehicles.js';
import { vehicleStewards } from './access.js';
import { notify } from './notify.js';
import { audit } from './audit.js';

/**
 * Turns the service engine and document dates into notifications.
 * Idempotent: every notification has a dedupe key, so running it twice sends nothing twice.
 */
export function runAlerts(now = new Date()) {
  const stats = { service: 0, documents: 0, expiredAuthorizations: 0, expiredFlags: 0, licences: 0 };
  const iso = now.toISOString();

  // 1. Service items crossing 80% / 95% / 100% / 125%
  for (const v of all(`SELECT * FROM vehicles WHERE id IN (SELECT DISTINCT vehicle_id FROM service_records)`)) {
    const health = vehicleHealth(v, now);
    for (const item of health.items) {
      if (!item.alert) continue;
      const sev = item.alert.level === 'soon' ? 'info' : item.alert.level === 'urgent' ? 'warn' : 'urgent';
      const where = item.finishLine.odometer != null ? ` Finish line: ${Number(item.finishLine.odometer).toLocaleString('en-GB')} ${item.unit === 'hours' ? 'h' : 'km'}.` : '';
      for (const uid of vehicleStewards(v)) {
        if (notify({ userId: uid, kind: 'service', severity: sev, title: `${item.alert.title}: ${item.short} on ${v.plate}`, body: `${String(item.message).replace(/\.$/, '')}.${where}`, vehicleId: v.id, dedupeKey: `svc:${v.id}:${item.code}:${item.recordId}:${item.alert.level}` })) stats.service++;
      }
    }
  }

  // 2. Documents: 30 days, 7 days, expired
  for (const v of all('SELECT * FROM vehicles')) {
    for (const d of documentsOf(v.id)) {
      const h = computeDocumentHealth(d, now);
      const bucket = h.remainingDays < 0 ? 'expired' : h.remainingDays <= 7 ? '7d' : h.remainingDays <= 30 ? '30d' : null;
      if (!bucket) continue;
      const raw_ = d.kind.replace('_', ' '); const label = raw_.charAt(0).toUpperCase() + raw_.slice(1);
      for (const uid of vehicleStewards(v)) {
        if (notify({ userId: uid, kind: 'document', severity: bucket === 'expired' ? 'urgent' : bucket === '7d' ? 'warn' : 'info', title: bucket === 'expired' ? `${label} has expired on ${v.plate}` : `${label} expires in ${h.remainingDays} days on ${v.plate}`, body: 'Driving with expired papers can lead to a fine.', vehicleId: v.id, dedupeKey: `doc:${d.id}:${bucket}` })) stats.documents++;
      }
    }
  }

  // 3. Authorizations that have ended: close them, and end any drive session that relied on them
  for (const a of all(`SELECT * FROM authorizations WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?`, [iso])) {
    run(`UPDATE authorizations SET status = 'expired' WHERE id = ?`, [a.id]);
    const s = one(`SELECT * FROM drive_sessions WHERE authorization_id = ? AND status = 'active'`, [a.id]);
    if (s) run(`UPDATE drive_sessions SET status = 'ended', ended_at = ?, end_reason = 'authorization_expired' WHERE id = ?`, [iso, s.id]);
    const v = one('SELECT * FROM vehicles WHERE id = ?', [a.vehicle_id]);
    if (v) for (const uid of vehicleStewards(v)) notify({ userId: uid, kind: 'authorization', severity: s ? 'warn' : 'info', title: `${a.driver_name || a.driver_phone}'s permission for ${v.plate} has ended`, body: s ? 'They were still driving. Their session was closed.' : null, vehicleId: v.id, dedupeKey: `auth:${a.id}:expired` });
    stats.expiredAuthorizations++;
  }

  // 4. Flags that lapse (persons of interest)
  for (const f of all(`SELECT * FROM flags WHERE status IN ('reported','active') AND expires_at IS NOT NULL AND expires_at <= ?`, [iso])) {
    run(`UPDATE flags SET status = 'expired', cleared_at = ?, clear_reason = 'Expired automatically' WHERE id = ?`, [iso, f.id]);
    audit({ action: 'flag.expire', targetType: f.subject_type, targetId: f.subject_id, details: { flag: f.id } });
    stats.expiredFlags++;
  }

  // 5. Licence expiring within 30 days
  for (const l of all(`SELECT * FROM licences WHERE status = 'valid'`)) {
    const days = Math.ceil((Date.parse(l.expires_at) - now.getTime()) / 86400000);
    if (days <= 30 && days >= -30) {
      const b = days < 0 ? 'expired' : days <= 7 ? '7d' : '30d';
      if (notify({ userId: l.user_id, kind: 'licence', severity: days < 0 ? 'urgent' : 'warn', title: days < 0 ? 'Your driving licence has expired' : `Your driving licence expires in ${days} days`, body: 'Renew it before you drive.', dedupeKey: `lic:${l.id}:${b}` })) stats.licences++;
    }
  }
  return stats;
}

let timer = null;
export function startScheduler(everyMs = 15 * 60 * 1000) {
  const tick = () => { try { runAlerts(); } catch (e) { console.error('scheduler:', e.message); } };
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
}
export const stopScheduler = () => { if (timer) clearInterval(timer); timer = null; };
