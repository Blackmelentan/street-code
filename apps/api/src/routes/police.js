import { Router } from 'express';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, requirePolice, isSupervisor, isAdmin, stationOf } from '../middleware/auth.js';
import { h, str, num, oneOf, isoDate, bad, forbidden, notFound, json } from '../lib/http.js';
import { newId, plateKey } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { CHECK_REASONS, FLAG_KINDS, FLAG_INSTRUCTIONS } from '../../../../packages/core/src/index.js';
import { verifyVehicle, verifyLicenceCode } from '../services/verify.js';
import { createFlag, approveFlag, rejectFlag, clearFlag, flagForOfficer, publicFlag, getFlag } from '../services/flags.js';
import { audit } from '../services/audit.js';
import { ownerLabel } from '../services/vehicles.js';

const r = Router();
r.use('/police', authenticate, requirePolice);
const checkLimiter = rateLimit({ windowMs: 60_000, max: 90, key: (req) => req.user.id, message: 'Slow down. Lookups are limited to protect people’s records.' });

function readLocation(b) {
  const loc = b.location || {};
  const lat = loc.lat == null ? null : num(loc.lat, 'Latitude', { min: -90, max: 90 });
  const lng = loc.lng == null ? null : num(loc.lng, 'Longitude', { min: -180, max: 180 });
  const label = str(loc.label, 'Location', { optional: true, max: 100 });
  // Every lookup must say where it happened. This is what makes the trail useful and misuse visible.
  if (!label && (lat == null || lng == null)) throw bad('Say where this check is happening (a place name or the device location).');
  return { lat, lng, label };
}

const common = (req) => ({
  user: req.user, ip: req.ip,
  reason: oneOf(req.body.reason, 'Reason for the check', CHECK_REASONS),
  caseRef: str(req.body.case_ref, 'Case reference', { optional: true, max: 40 }),
  location: readLocation(req.body),
});

r.get('/police/reasons', h((req, res) => res.json({ reasons: CHECK_REASONS, kinds: FLAG_KINDS, instructions: FLAG_INSTRUCTIONS })));

r.post('/police/check', checkLimiter, h((req, res) => {
  res.json(verifyVehicle({ ...common(req), query: str(req.body.query, 'Plate or VIN', { min: 3, max: 20 }), licenceCode: str(req.body.licence_code, 'Licence code', { optional: true, max: 40 }) }));
}));

r.post('/police/check-licence', checkLimiter, h((req, res) => {
  res.json(verifyLicenceCode({ ...common(req), code: str(req.body.code, 'Licence code', { min: 6, max: 40 }) }));
}));

/* ---- the officer's own trail, and the station's for supervisors ---- */
r.get('/police/checks', h((req, res) => {
  const st = stationOf(req.user);
  const scope = req.query.scope === 'station' && isSupervisor(req.user);
  const rows = scope
    ? all(`SELECT c.*, u.name AS officer_name FROM police_checks c JOIN users u ON u.id = c.officer_id WHERE c.org_id = ? ORDER BY c.created_at DESC LIMIT 200`, [st.org_id])
    : all(`SELECT c.*, u.name AS officer_name FROM police_checks c JOIN users u ON u.id = c.officer_id WHERE c.officer_id = ? ORDER BY c.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ checks: rows.map((c) => ({ id: c.id, at: c.created_at, officer: c.officer_name, badge: c.badge, kind: c.subject_kind, query: c.query, reason: c.reason, case_ref: c.case_ref, location: c.location_label, outcome: c.outcome, notes: all('SELECT note, created_at FROM police_check_notes WHERE check_id = ? ORDER BY created_at', [c.id]) })) });
}));

r.post('/police/checks/:id/notes', h((req, res) => {
  const c = one('SELECT * FROM police_checks WHERE id = ?', [req.params.id]);
  if (!c || (c.officer_id !== req.user.id && !isSupervisor(req.user))) throw notFound('Check not found.');
  run('INSERT INTO police_check_notes (id, check_id, officer_id, note) VALUES (?,?,?,?)', [newId('pcn'), c.id, req.user.id, str(req.body.note, 'Note', { min: 2, max: 1000 })]);
  res.status(201).json({ ok: true });
}));

/* ---- flags ---- */
const subjectLabel = (f) => {
  if (f.subject_type === 'vehicle') { const v = one('SELECT plate, make, model FROM vehicles WHERE id = ?', [f.subject_id]); return v ? { title: v.plate, sub: `${v.make} ${v.model}` } : { title: 'Vehicle', sub: '' }; }
  const u = one('SELECT u.name, l.licence_number FROM users u LEFT JOIN licences l ON l.user_id = u.id WHERE u.id = ?', [f.subject_id]);
  return { title: u?.name || 'Person', sub: u?.licence_number || '' };
};

r.get('/police/flags', h((req, res) => {
  const status = req.query.status === 'all' ? null : req.query.status || 'active';
  const rows = all(`SELECT * FROM flags ${status ? 'WHERE status = ?' : `WHERE status IN ('reported','active','cleared','expired','rejected')`} ORDER BY CASE level WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END, created_at DESC LIMIT 200`, status ? [status] : []);
  res.json({ flags: rows.map((f) => ({ ...flagForOfficer(f, req.user), subject: subjectLabel(f), creator: one('SELECT name FROM users WHERE id = ?', [f.created_by])?.name, can_approve: f.status === 'reported' && (f.reported_by_owner ? true : isSupervisor(req.user) && f.created_by !== req.user.id) })) });
}));

// Find a person to flag: by licence number. Logged, because it is a lookup of a person.
r.get('/police/person', h((req, res) => {
  const n = str(req.query.licence, 'Licence number', { min: 4, max: 20 }).toUpperCase().replace(/\s+/g, '');
  const p = one('SELECT u.id, u.name, l.licence_number, l.status FROM licences l JOIN users u ON u.id = l.user_id WHERE l.licence_number = ?', [n]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'police.person_lookup', targetType: 'licence', targetId: n, details: { found: !!p }, ip: req.ip });
  if (!p) throw notFound('No person is registered with that licence number.');
  res.json({ person: p });
}));

r.post('/police/flags', h((req, res) => {
  const kind = oneOf(req.body.kind, 'Flag type', Object.keys(FLAG_KINDS));
  const def = FLAG_KINDS[kind];
  let subjectId;
  if (def.subject === 'vehicle') {
    const v = req.body.vehicle_id ? one('SELECT id FROM vehicles WHERE id = ?', [req.body.vehicle_id]) : one('SELECT id FROM vehicles WHERE plate_key = ? OR vin = ?', [plateKey(req.body.plate), plateKey(req.body.plate)]);
    if (!v) throw notFound('No vehicle with that plate is registered.');
    subjectId = v.id;
  } else {
    const p = req.body.user_id ? one('SELECT id FROM users WHERE id = ?', [req.body.user_id]) : one('SELECT user_id AS id FROM licences WHERE licence_number = ?', [String(req.body.licence_number || '').toUpperCase().replace(/\s+/g, '')]);
    if (!p) throw notFound('No person found.');
    subjectId = p.id;
  }
  const flag = createFlag({
    user: req.user, ip: req.ip, subjectType: def.subject, subjectId, kind,
    summary: str(req.body.summary, 'Summary', { min: 5, max: 200 }), detail: str(req.body.detail, 'Restricted detail', { optional: true, max: 2000 }),
    instruction: oneOf(req.body.instruction || 'call_dispatch', 'Instruction', Object.keys(FLAG_INSTRUCTIONS)), caseRef: str(req.body.case_ref, 'Case reference', { optional: true, max: 40 }),
    expiresAt: isoDate(req.body.expires_at, 'Expiry', { optional: true }),
  });
  res.status(201).json({ flag: publicFlag(flag) });
}));

r.post('/police/flags/:id/approve', h((req, res) => res.json({ flag: publicFlag(approveFlag({ user: req.user, id: req.params.id, ip: req.ip })) })));
r.post('/police/flags/:id/reject', h((req, res) => res.json({ flag: publicFlag(rejectFlag({ user: req.user, id: req.params.id, reason: str(req.body.reason, 'Reason', { optional: true, max: 200 }), ip: req.ip })) })));
r.post('/police/flags/:id/clear', h((req, res) => res.json({ flag: publicFlag(clearFlag({ user: req.user, id: req.params.id, reason: str(req.body.reason, 'Reason', { min: 3, max: 200 }), ip: req.ip })) })));

// Last known positions of a vehicle on an ACTIVE stolen flag. Nothing else is trackable by police.
r.get('/police/flags/:id/track', h((req, res) => {
  const f = getFlag(req.params.id);
  if (!f || f.subject_type !== 'vehicle' || f.status !== 'active' || f.kind !== 'stolen') throw notFound('Tracking is only available for vehicles on the active stolen list.');
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'police.track', targetType: 'vehicle', targetId: f.subject_id, details: { flag: f.id }, ip: req.ip });
  res.json({
    sightings: all('SELECT lat, lng, label, source, created_at FROM sightings WHERE flag_id = ? ORDER BY created_at DESC LIMIT 30', [f.id]),
    telemetry: all(`SELECT lat, lng, speed_kph, ts FROM telemetry WHERE vehicle_id = ? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 30`, [f.subject_id]),
  });
}));

r.get('/police/feed', h((req, res) => {
  const sightings = all(`SELECT s.*, f.kind, f.level, f.summary, v.plate FROM sightings s JOIN flags f ON f.id = s.flag_id LEFT JOIN vehicles v ON v.id = s.vehicle_id ORDER BY s.created_at DESC LIMIT 40`);
  const pending = one(`SELECT COUNT(*) AS n FROM flags WHERE status = 'reported'`).n;
  const red = one(`SELECT COUNT(*) AS n FROM flags WHERE status = 'active' AND level = 'red'`).n;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const mine = one(`SELECT COUNT(*) AS n FROM police_checks WHERE officer_id = ? AND created_at >= ?`, [req.user.id, today.toISOString()]).n;
  const hits = one(`SELECT COUNT(*) AS n FROM police_checks WHERE created_at >= ? AND outcome = 'flag_hit'`, [today.toISOString()]).n;
  res.json({ sightings, stats: { pending, red, checksToday: mine, hitsToday: hits } });
}));

export default r;
