import { Router } from 'express';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, isAdmin, membershipIn, rankIn, garageStaffIn, isOrgManager } from '../middleware/auth.js';
import { h, str, num, oneOf, isoDate, bad, conflict, forbidden, notFound, HttpError, json } from '../lib/http.js';
import { newId, normPhone, plateKey } from '../lib/ids.js';
import { ORG_ROLES, ROLES_BY_ORG, EMPLOYMENT, VEHICLE_CLASSES, SERVICE_ITEMS, OIL_TYPES } from '../../../../packages/core/src/index.js';
import { requireVehicle, canManage, vehicleStewards, getVehicle } from '../services/access.js';
import { recordOdometer, guardOdometer, addServiceRecord, vehicleHealth } from '../services/vehicles.js';
import { appendBlock } from '../services/passport.js';
import { notify } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { initiateEscrow, verifyWebhookSignature } from '../services/momo.js';

const r = Router();
r.use(['/orgs', '/memberships', '/me', '/jobs'], authenticate);

const orgOut = (o) => ({ ...o, specialties: json(o.specialties, []) });
const requireOrg = (id) => { const o = one('SELECT * FROM orgs WHERE id = ?', [id]); if (!o) throw notFound('Organisation not found.'); return o; };

r.get('/orgs/mine', h((req, res) => {
  res.json({ orgs: req.user.memberships.map((m) => ({ membership_id: m.id, role: m.role, employment: m.employment, ...orgOut(requireOrg(m.org_id)) })) });
}));

// Register a garage, fleet or car wash. Garages and car washes are "pending" until an administrator verifies them.
r.post('/orgs', h((req, res) => {
  const type = oneOf(req.body.type, 'Type', ['garage', 'fleet', 'carwash']);
  const id = newId('org');
  tx(() => {
    run(`INSERT INTO orgs (id, type, name, location, address, phone, bays, specialties, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, type, str(req.body.name, 'Name', { min: 2, max: 80 }), str(req.body.location, 'Area', { optional: true, max: 60 }), str(req.body.address, 'Address', { optional: true, max: 120 }),
        str(req.body.phone, 'Phone', { optional: true, max: 20 }), num(req.body.bays ?? 0, 'Bays', { min: 0, max: 200, int: true }),
        JSON.stringify(Array.isArray(req.body.specialties) ? req.body.specialties.slice(0, 8).map((s) => String(s).slice(0, 30)) : []), type === 'fleet' ? 'verified' : 'pending', req.user.id]);
    run(`INSERT INTO memberships (id, org_id, user_id, role, employment, status, started_at) VALUES (?,?,?,?,?,?,?)`, [newId('mem'), id, req.user.id, 'owner', 'owner', 'active', new Date().toISOString()]);
  });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'org.create', targetType: 'org', targetId: id, details: { type }, ip: req.ip });
  res.status(201).json({ org: orgOut(requireOrg(id)) });
}));

/* ---- staff: the boss manages the team ---- */
const memberOut = (m) => ({ ...m, user_name: m.user_id ? one('SELECT name FROM users WHERE id = ?', [m.user_id])?.name : null, role_label: ORG_ROLES[m.role]?.label });

r.get('/orgs/:id/members', h((req, res) => {
  const o = requireOrg(req.params.id);
  if (!membershipIn(req.user, o.id) && !isAdmin(req.user)) throw forbidden();
  const rows = all(`SELECT m.*, u.name AS user_name, u.phone AS user_phone FROM memberships m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status != 'ended' ORDER BY m.created_at`, [o.id]);
  const canSeeContacts = isOrgManager(req.user, o.id) || isAdmin(req.user);
  res.json({ members: rows.map((m) => ({ ...m, role_label: ORG_ROLES[m.role]?.label, user_phone: canSeeContacts ? m.user_phone : undefined })), roles: ROLES_BY_ORG[o.type], canManage: canSeeContacts });
}));

r.post('/orgs/:id/members', h((req, res) => {
  const o = requireOrg(req.params.id);
  if (o.type === 'station' && !isAdmin(req.user)) throw forbidden('Police stations are staffed by an administrator.');
  if (!isAdmin(req.user) && !isOrgManager(req.user, o.id)) throw forbidden('Only owners and managers can add staff.');
  const role = oneOf(req.body.role, 'Role', ROLES_BY_ORG[o.type]);
  const employment = oneOf(req.body.employment || 'employee', 'Employment', EMPLOYMENT);
  // You can only add people below your own rank: a manager cannot appoint another manager or an owner.
  if (!isAdmin(req.user) && ORG_ROLES[role].rank >= rankIn(req.user, o.id)) throw forbidden('You can only add people with a lower role than yours.');
  const phone = normPhone(str(req.body.phone, 'Phone', { min: 7, max: 20 }));
  const u = one('SELECT id FROM users WHERE phone = ?', [phone]);
  const dupe = one(`SELECT id FROM memberships WHERE org_id = ? AND status != 'ended' AND (user_id = ? OR invited_phone = ?)`, [o.id, u?.id ?? '-', phone]);
  if (dupe) throw conflict('That person is already on the team or has a pending invitation.');
  const id = newId('mem');
  run(`INSERT INTO memberships (id, org_id, user_id, invited_phone, role, employment, badge_number, status, invited_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, o.id, u?.id ?? null, u ? null : phone, role, employment, str(req.body.badge_number, 'Badge', { optional: true, max: 20 }), 'invited', req.user.id]);
  if (u) notify({ userId: u.id, kind: 'invitation', title: `${o.name} invited you as ${ORG_ROLES[role].label.toLowerCase()}`, body: 'Open Profile to accept.', dedupeKey: `inv:${id}` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'member.invite', targetType: 'org', targetId: o.id, details: { role, employment, phone }, ip: req.ip });
  res.status(201).json({ member: memberOut(one('SELECT * FROM memberships WHERE id = ?', [id])), hasAccount: !!u });
}));

r.get('/me/invitations', h((req, res) => {
  res.json({ invitations: all(`SELECT m.*, o.name AS org_name, o.type AS org_type FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.status = 'invited'`, [req.user.id]).map((m) => ({ ...m, role_label: ORG_ROLES[m.role]?.label })) });
}));

r.post('/memberships/:id/respond', h((req, res) => {
  const m = one('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
  if (!m || m.user_id !== req.user.id || m.status !== 'invited') throw notFound('Invitation not found.');
  const accept = req.body.accept === true;
  run(`UPDATE memberships SET status = ?, started_at = ?, ended_at = ? WHERE id = ?`, [accept ? 'active' : 'ended', accept ? new Date().toISOString() : null, accept ? null : new Date().toISOString(), m.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: accept ? 'member.accept' : 'member.decline', targetType: 'org', targetId: m.org_id, ip: req.ip });
  res.json({ ok: true });
}));

const managing = (req, m) => {
  const o = requireOrg(m.org_id);
  if (isAdmin(req.user)) return o;
  if (o.type === 'station') throw forbidden('Police stations are staffed by an administrator.');
  const me = rankIn(req.user, m.org_id);
  if (m.user_id === req.user.id) throw forbidden('You cannot change your own role. Ask the owner.');
  if (me < ORG_ROLES.manager.rank) throw forbidden('Only owners and managers can manage staff.');
  if ((ORG_ROLES[m.role]?.rank ?? 0) >= me) throw forbidden('You can only manage people below your own role.');
  return o;
};

r.patch('/memberships/:id', h((req, res) => {
  const m = one('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
  if (!m || m.status === 'ended') throw notFound();
  const o = managing(req, m);
  let { role, status } = req.body;
  if (role !== undefined) {
    oneOf(role, 'Role', ROLES_BY_ORG[o.type]);
    if (!isAdmin(req.user) && ORG_ROLES[role].rank >= rankIn(req.user, o.id)) throw forbidden('You cannot give someone a role at or above your own.');
  } else role = m.role;
  if (status !== undefined) oneOf(status, 'Status', ['active', 'suspended']); else status = m.status;
  run('UPDATE memberships SET role = ?, status = ? WHERE id = ?', [role, status, m.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'member.update', targetType: 'org', targetId: o.id, details: { member: m.id, role, status }, ip: req.ip });
  res.json({ member: memberOut(one('SELECT * FROM memberships WHERE id = ?', [m.id])) });
}));

r.delete('/memberships/:id', h((req, res) => {
  const m = one('SELECT * FROM memberships WHERE id = ?', [req.params.id]);
  if (!m || m.status === 'ended') throw notFound();
  const own = m.user_id === req.user.id;
  if (own) {
    const owners = one(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'`, [m.org_id]).n;
    if (m.role === 'owner' && owners <= 1) throw conflict('You are the only owner. Add another owner before you leave.');
  } else managing(req, m);
  run(`UPDATE memberships SET status = 'ended', ended_at = ? WHERE id = ?`, [new Date().toISOString(), m.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'member.remove', targetType: 'org', targetId: m.org_id, details: { member: m.id, self: own }, ip: req.ip });
  res.json({ ok: true });
}));

/* ---- job cards ---- */
const jobOut = (j) => {
  const v = getVehicle(j.vehicle_id);
  return { ...j, dtcs: json(j.dtcs, []), parts: json(j.parts, []), vehicle: v && { id: v.id, plate: v.plate, make: v.make, model: v.model, year: v.year, vehicle_class: v.vehicle_class, odometer: v.odometer }, org_name: one('SELECT name FROM orgs WHERE id = ?', [j.org_id])?.name, customer_name: one('SELECT name FROM users WHERE id = ?', [j.customer_id])?.name, mechanic_name: j.mechanic_id ? one('SELECT name FROM users WHERE id = ?', [j.mechanic_id])?.name : null };
};
const requireJob = (id) => { const j = one('SELECT * FROM jobs WHERE id = ?', [id]); if (!j) throw notFound('Job not found.'); return j; };
const staffOnly = (user, orgId) => { if (!garageStaffIn(user, orgId) && !(membershipIn(user, orgId)?.role === 'attendant')) throw forbidden('Only staff of this garage can do that.'); };
const minor = (v, n) => (v == null || v === '' ? 0 : Math.round(num(v, n, { min: 0, max: 1_000_000 }) * 100));

r.post('/orgs/:id/jobs', h((req, res) => {
  const o = requireOrg(req.params.id);
  if (o.type !== 'garage' || o.status !== 'verified') throw bad('This garage is not open for jobs yet.');
  const complaint = str(req.body.complaint, 'What needs doing', { min: 3, max: 500 });
  const member = membershipIn(req.user, o.id);
  const v = req.body.vehicle_id ? requireVehicle(req.body.vehicle_id) : one('SELECT * FROM vehicles WHERE plate_key = ?', [plateKey(req.body.plate)]);
  if (!v) throw notFound('No vehicle with that plate is registered.');
  let customer, consent;
  if (member) { // staff opening a job on the owner's behalf: the owner has to approve it before any record is touched
    customer = vehicleStewards(v)[0]; consent = 0;
    if (!customer) throw bad('This vehicle has no owner to notify.');
  } else { // the customer requests it themselves
    if (!canManage(req.user, v)) throw forbidden('You can only request jobs for your own vehicles.');
    customer = req.user.id; consent = 1;
  }
  const id = newId('job');
  run(`INSERT INTO jobs (id, org_id, vehicle_id, customer_id, opened_by, owner_consent, complaint, odometer_in) VALUES (?,?,?,?,?,?,?,?)`, [id, o.id, v.id, customer, req.user.id, consent, complaint, v.odometer]);
  if (!consent) notify({ userId: customer, kind: 'job', severity: 'warn', title: `${o.name} opened a job on ${v.plate}`, body: `“${complaint}”. Approve it in Jobs so they can record the work.`, vehicleId: v.id, dedupeKey: `job:${id}:consent` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'job.open', targetType: 'job', targetId: id, details: { org: o.id, byStaff: !!member }, ip: req.ip });
  res.status(201).json({ job: jobOut(requireJob(id)) });
}));

r.get('/orgs/:id/jobs', h((req, res) => {
  const o = requireOrg(req.params.id);
  staffOnly(req.user, o.id);
  res.json({ jobs: all('SELECT * FROM jobs WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', [o.id]).map(jobOut) });
}));

r.get('/me/jobs', h((req, res) => {
  res.json({ jobs: all('SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]).map(jobOut) });
}));

r.post('/jobs/:id/consent', h((req, res) => {
  const j = requireJob(req.params.id);
  const v = requireVehicle(j.vehicle_id);
  if (!canManage(req.user, v)) throw forbidden();
  const approve = req.body.approve === true;
  run(`UPDATE jobs SET owner_consent = ?, status = ?, updated_at = ? WHERE id = ?`, [approve ? 1 : 0, approve ? (j.status === 'requested' ? 'requested' : j.status) : 'cancelled', new Date().toISOString(), j.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: approve ? 'job.consent' : 'job.decline', targetType: 'job', targetId: j.id, ip: req.ip });
  res.json({ job: jobOut(requireJob(j.id)) });
}));

// Garage: quote, assign, progress
r.patch('/jobs/:id', h((req, res) => {
  const j = requireJob(req.params.id);
  staffOnly(req.user, j.org_id);
  if (!j.owner_consent) throw conflict('The owner has not approved this job yet.');
  if (['completed', 'cancelled'].includes(j.status)) throw conflict('This job is closed.');
  const b = req.body;
  const labour = b.labour_gmd !== undefined ? minor(b.labour_gmd, 'Labour') : j.labour_minor;
  const parts = b.parts_gmd !== undefined ? minor(b.parts_gmd, 'Parts') : j.parts_minor;
  const total = labour + parts;
  let status = j.status;
  if (b.status !== undefined) {
    status = oneOf(b.status, 'Status', ['quoted', 'in_progress', 'ready', 'cancelled']);
    const ok = { requested: ['quoted', 'cancelled'], quoted: ['quoted', 'cancelled'], accepted: ['in_progress', 'cancelled'], in_progress: ['ready', 'cancelled'], ready: ['in_progress', 'cancelled'] }[j.status] || [];
    if (!ok.includes(status)) throw conflict(`A ${j.status} job cannot move to ${status}.`);
    if (status === 'quoted' && total <= 0) throw bad('Add labour or parts cost before sending a quote.');
  }
  const mech = b.mechanic_id ? one(`SELECT user_id FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner','manager','mechanic')`, [j.org_id, b.mechanic_id]) : null;
  if (b.mechanic_id && !mech) throw bad('That person is not a mechanic at this garage.');
  run(`UPDATE jobs SET status = ?, labour_minor = ?, parts_minor = ?, total_minor = ?, mechanic_id = ?, dtcs = ?, parts = ?, updated_at = ? WHERE id = ?`,
    [status, labour, parts, total, b.mechanic_id ?? j.mechanic_id ?? (garageStaffIn(req.user, j.org_id) ? req.user.id : null), JSON.stringify(Array.isArray(b.dtcs) ? b.dtcs.slice(0, 20).map(String) : json(j.dtcs, [])), JSON.stringify(Array.isArray(b.parts) ? b.parts.slice(0, 40) : json(j.parts, [])), new Date().toISOString(), j.id]);
  if (status === 'quoted' && j.status !== 'quoted') notify({ userId: j.customer_id, kind: 'job', title: 'You have a quote', body: `D${(total / 100).toFixed(2)} for ${requireVehicle(j.vehicle_id).plate}. Review it in Jobs.`, vehicleId: j.vehicle_id, dedupeKey: `job:${j.id}:quote:${total}` });
  res.json({ job: jobOut(requireJob(j.id)) });
}));

r.post('/jobs/:id/accept', h((req, res) => {
  const j = requireJob(req.params.id);
  if (j.customer_id !== req.user.id) throw forbidden();
  if (j.status !== 'quoted') throw conflict('There is no quote to accept.');
  run(`UPDATE jobs SET status = 'accepted', updated_at = ? WHERE id = ?`, [new Date().toISOString(), j.id]);
  res.json({ job: jobOut(requireJob(j.id)) });
}));

// Complete the job. This is the ONLY way a garage seals anything into a passport: verified odometer, verified service records, signed block.
r.post('/jobs/:id/complete', h((req, res) => {
  const j = requireJob(req.params.id);
  if (!garageStaffIn(req.user, j.org_id)) throw forbidden('Only a mechanic or manager at this garage can complete a job.');
  const org = requireOrg(j.org_id);
  if (org.status !== 'verified') throw forbidden('This garage is not verified, so it cannot seal records into a passport.');
  if (!j.owner_consent) throw conflict('The owner has not approved this job.');
  if (!['accepted', 'in_progress', 'ready'].includes(j.status)) throw conflict(`A ${j.status} job cannot be completed.`);
  const v = requireVehicle(j.vehicle_id);
  const cls = VEHICLE_CLASSES[v.vehicle_class];
  const odometer = num(req.body.odometer, 'Odometer', { min: 0, max: 5_000_000 });
  const eventType = oneOf(req.body.event || 'ROUTINE_SERVICE', 'Event', ['ROUTINE_SERVICE', 'MAJOR_REPAIR', 'ROADWORTHINESS_TEST']);
  const summary = str(req.body.summary, 'Summary of work', { min: 5, max: 400 });
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 12) : [];
  const clean = items.map((it) => {
    const code = oneOf(it.item_code, 'Service item', Object.keys(SERVICE_ITEMS));
    if (!SERVICE_ITEMS[code].appliesTo(cls)) throw bad(`${SERVICE_ITEMS[code].label} does not apply to this vehicle.`);
    const product = code === 'engine_oil' ? { oil_type: oneOf(it.oil_type, 'Oil type', Object.keys(OIL_TYPES)), grade: str(it.oil_grade, 'Oil grade', { optional: true, max: 40 }), brand: str(it.brand, 'Brand', { optional: true, max: 40 }), filter_changed: it.filter_changed !== false } : null;
    return { code, product, notes: str(it.notes, 'Notes', { optional: true, max: 200 }) };
  });
  const actor = req.user;
  guardOdometer({ vehicle: v, value: odometer, source: 'garage', user: actor, ip: req.ip }); // before the transaction, so a refusal is still recorded
  const done = tx(() => {
    recordOdometer({ vehicle: v, value: odometer, source: 'garage', user: actor, note: `Job ${j.id}`, ip: req.ip });
    const block = appendBlock({
      vehicleId: v.id, eventType, mileage: odometer, authority: 'garage', actor: { id: actor.id, role: 'mechanic', name: actor.name, orgId: org.id },
      description: `${summary} (${org.name})`,
      payload: { job: j.id, garage: org.name, items: clean.map((c) => ({ item: c.code, product: c.product })), invoice: { total_minor: j.total_minor, labour_minor: j.labour_minor, parts_minor: j.parts_minor }, dtcs: json(j.dtcs, []) },
    });
    const now = new Date().toISOString();
    for (const c of clean) addServiceRecord({ vehicleId: v.id, itemCode: c.code, performedAt: now, odometer, userId: actor.id, orgId: org.id, product: c.product, notes: c.notes, jobId: j.id, passportBlockId: block.id, verified: true });
    run(`UPDATE jobs SET status = 'completed', work_done = ?, completed_at = ?, updated_at = ?, odometer_in = COALESCE(odometer_in, ?) WHERE id = ?`, [summary, now, now, odometer, j.id]);
    return block;
  });
  notify({ userId: j.customer_id, kind: 'job', title: `Work on ${v.plate} is complete`, body: `${org.name} sealed it into the vehicle passport.`, vehicleId: v.id, dedupeKey: `job:${j.id}:done` });
  audit({ actor: { id: actor.id, label: actor.name }, action: 'job.complete', targetType: 'job', targetId: j.id, details: { block: done.id }, ip: req.ip });
  res.json({ job: jobOut(requireJob(j.id)), block: { id: done.id, index: done.block_index, hash: done.hash }, health: vehicleHealth(requireVehicle(v.id)) });
}));

// Customer pays into escrow for a job
r.post('/jobs/:id/pay', h((req, res) => {
  const j = requireJob(req.params.id);
  const e = initiateEscrow({ user: req.user, jobId: j.id, provider: req.body.provider, phone: normPhone(str(req.body.phone, 'Mobile money number', { min: 7 })), amountMinor: j.total_minor || Math.round(num(req.body.amount_gmd, 'Amount', { min: 1 }) * 100), ip: req.ip });
  res.status(201).json({ escrow: e });
}));

export default r;
