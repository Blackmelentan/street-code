import { Router } from 'express';
import { all, one, run } from '../db/database.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { h, str, num, oneOf, isoDate, bad, notFound, conflict, json } from '../lib/http.js';
import { newId, normPhone } from '../lib/ids.js';
import { LICENCE_GROUPS, ROLES_BY_ORG } from '../../../../packages/core/src/index.js';
import { audit, verifyAuditChain } from '../services/audit.js';
import { notify } from '../services/notify.js';

const r = Router();
r.use('/admin', authenticate, requireAdmin);
const who = (req) => ({ id: req.user.id, label: req.user.name });

r.get('/admin/queue', h((req, res) => {
  res.json({
    orgs: all(`SELECT o.*, u.name AS created_by_name FROM orgs o LEFT JOIN users u ON u.id = o.created_by WHERE o.status = 'pending' ORDER BY o.created_at`),
    licences: all(`SELECT l.*, u.name AS holder FROM licences l JOIN users u ON u.id = l.user_id WHERE l.status = 'pending' ORDER BY l.created_at`).map((l) => ({ ...l, classes: json(l.classes, []) })),
    documents: all(`SELECT d.*, v.plate FROM vehicle_documents d JOIN vehicles v ON v.id = d.vehicle_id WHERE d.status = 'pending' ORDER BY d.created_at LIMIT 100`),
    disputes: all(`SELECT * FROM escrow WHERE status = 'disputed'`),
  });
}));

r.post('/admin/orgs/:id/verify', h((req, res) => {
  const o = one('SELECT * FROM orgs WHERE id = ?', [req.params.id]);
  if (!o) throw notFound();
  const status = req.body.approve === true ? 'verified' : 'suspended';
  run('UPDATE orgs SET status = ?, verified_by = ? WHERE id = ?', [status, req.user.id, o.id]);
  audit({ actor: who(req), action: `org.${status}`, targetType: 'org', targetId: o.id, ip: req.ip });
  if (o.created_by) notify({ userId: o.created_by, kind: 'org', title: status === 'verified' ? `${o.name} is verified` : `${o.name} was not approved`, dedupeKey: `org:${o.id}:${status}` });
  res.json({ ok: true, status });
}));

// This is the licensing authority's decision. A self-declared licence is never "valid" until it is verified here (or by an integration with the issuing authority).
r.post('/admin/licences/:id/verify', h((req, res) => {
  const l = one('SELECT * FROM licences WHERE id = ?', [req.params.id]);
  if (!l) throw notFound();
  const status = oneOf(req.body.status, 'Status', ['valid', 'suspended', 'revoked']);
  const classes = Array.isArray(req.body.classes) ? req.body.classes : json(l.classes, []);
  if (classes.some((c) => !LICENCE_GROUPS[c])) throw bad('Unknown licence group.');
  run(`UPDATE licences SET status = ?, classes = ?, points = ?, commercial_clearance_until = ?, verified_by = ?, verified_at = ? WHERE id = ?`,
    [status, JSON.stringify(classes), req.body.points == null ? l.points : num(req.body.points, 'Points', { min: 0, max: 100, int: true }), isoDate(req.body.commercial_clearance_until, 'Clearance date', { optional: true }) ?? l.commercial_clearance_until, req.user.id, new Date().toISOString(), l.id]);
  audit({ actor: who(req), action: `licence.${status}`, targetType: 'licence', targetId: l.id, ip: req.ip });
  notify({ userId: l.user_id, kind: 'licence', severity: status === 'valid' ? 'info' : 'urgent', title: status === 'valid' ? 'Your driving licence is verified' : `Your driving licence is ${status}`, dedupeKey: `lic:${l.id}:${status}:${Date.now()}` });
  res.json({ ok: true });
}));

r.post('/admin/documents/:id/verify', h((req, res) => {
  const d = one('SELECT * FROM vehicle_documents WHERE id = ?', [req.params.id]);
  if (!d) throw notFound();
  run('UPDATE vehicle_documents SET status = ?, verified_by = ? WHERE id = ?', [req.body.approve === true ? 'verified' : 'rejected', req.user.id, d.id]);
  audit({ actor: who(req), action: 'document.verify', targetType: 'vehicle', targetId: d.vehicle_id, details: { id: d.id, approve: req.body.approve === true }, ip: req.ip });
  res.json({ ok: true });
}));

/* ---- police stations and officers exist only because an administrator created them ---- */
r.post('/admin/stations', h((req, res) => {
  const id = newId('org');
  run(`INSERT INTO orgs (id, type, name, location, status, verified_by, created_by) VALUES (?,?,?,?,?,?,?)`, [id, 'station', str(req.body.name, 'Station name', { min: 3, max: 80 }), str(req.body.location, 'Area', { optional: true, max: 60 }), 'verified', req.user.id, req.user.id]);
  audit({ actor: who(req), action: 'station.create', targetType: 'org', targetId: id, ip: req.ip });
  res.status(201).json({ id });
}));

r.post('/admin/stations/:id/members', h((req, res) => {
  const o = one(`SELECT * FROM orgs WHERE id = ? AND type = 'station'`, [req.params.id]);
  if (!o) throw notFound('Station not found.');
  const u = one('SELECT id FROM users WHERE phone = ?', [normPhone(str(req.body.phone, 'Phone'))]);
  if (!u) throw notFound('That person has not created an account yet.');
  const role = oneOf(req.body.role, 'Role', ROLES_BY_ORG.station);
  if (one(`SELECT id FROM memberships WHERE org_id = ? AND user_id = ? AND status != 'ended'`, [o.id, u.id])) throw conflict('Already a member.');
  const id = newId('mem');
  run(`INSERT INTO memberships (id, org_id, user_id, role, employment, badge_number, status, invited_by, started_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, o.id, u.id, role, 'employee', str(req.body.badge_number, 'Badge number', { min: 2, max: 20 }), 'active', req.user.id, new Date().toISOString()]);
  audit({ actor: who(req), action: 'station.add_member', targetType: 'org', targetId: o.id, details: { user: u.id, role }, ip: req.ip });
  res.status(201).json({ id });
}));

r.get('/admin/audit', h((req, res) => {
  res.json({ entries: all(`SELECT seq, ts, actor_label, action, target_type, target_id, details, ip FROM audit_logs ORDER BY seq DESC LIMIT ?`, [Math.min(500, Number(req.query.limit) || 100)]).map((e) => ({ ...e, details: json(e.details, {}) })) });
}));
r.get('/admin/audit/verify', h((req, res) => res.json(verifyAuditChain())));
r.get('/admin/users', h((req, res) => {
  const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
  res.json({ users: all(`SELECT id, name, phone, platform_role, status, created_at FROM users WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 50`, [q, q]) });
}));

export default r;
