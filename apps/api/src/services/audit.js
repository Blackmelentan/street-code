import crypto from 'node:crypto';
import { all, one, run, tx } from '../db/database.js';
import { canonical } from '../lib/canonical.js';
import { newId } from '../lib/ids.js';

const GENESIS = '0'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Who did it, from an Express request (or a plain label for system jobs). */
export const actorOf = (req) => (req?.user ? { id: req.user.id, label: `${req.user.name}` } : { id: null, label: 'system' });

/**
 * Append to the audit trail. Each row's hash covers the previous row's hash, and
 * the table refuses UPDATE/DELETE, so history cannot be rewritten quietly.
 */
export function audit({ actor = { id: null, label: 'system' }, action, targetType = null, targetId = null, details = {}, ip = null }) {
  return tx(() => {
    const prev = one('SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1')?.hash || GENESIS;
    const id = newId('aud');
    const ts = new Date().toISOString();
    const body = { id, ts, actor_id: actor.id, action, target_type: targetType, target_id: targetId, details };
    const hash = sha(prev + canonical(body));
    run(
      `INSERT INTO audit_logs (id, ts, actor_id, actor_label, action, target_type, target_id, details, ip, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, ts, actor.id, actor.label, action, targetType, targetId, JSON.stringify(details), ip, prev, hash],
    );
    return { id, ts, hash };
  });
}

export function verifyAuditChain() {
  const rows = all('SELECT * FROM audit_logs ORDER BY seq ASC');
  let prev = GENESIS;
  for (const r of rows) {
    const body = { id: r.id, ts: r.ts, actor_id: r.actor_id, action: r.action, target_type: r.target_type, target_id: r.target_id, details: JSON.parse(r.details) };
    if (r.prev_hash !== prev) return { valid: false, entries: rows.length, brokenAt: r.seq, reason: 'Chain link does not match the previous entry' };
    if (sha(prev + canonical(body)) !== r.hash) return { valid: false, entries: rows.length, brokenAt: r.seq, reason: 'Entry contents do not match their hash' };
    prev = r.hash;
  }
  return { valid: true, entries: rows.length, head: prev === GENESIS ? null : prev };
}
