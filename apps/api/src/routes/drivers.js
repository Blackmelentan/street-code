import { Router } from 'express';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, membershipIn } from '../middleware/auth.js';
import { h, str, num, oneOf, isoDate, bad, conflict, forbidden, notFound, HttpError, json } from '../lib/http.js';
import { newId, normPhone } from '../lib/ids.js';
import { requireVehicle, canManage, activeAuthorization, isFleetDriver } from '../services/access.js';
import { serializeVehicle, recordOdometer, openFlagsOn } from '../services/vehicles.js';
import { recordSighting } from '../services/flags.js';
import { notify } from '../services/notify.js';
import { audit } from '../services/audit.js';
import { checkLicence, AUTHORIZATION_KINDS } from '../../../../packages/core/src/index.js';

const r = Router();
r.use(['/vehicles', '/authorizations', '/me/authorizations', '/drive'], authenticate);

/* ---- lending a vehicle: "Fatou may drive my Corolla from Friday to Sunday" ---- */
r.post('/vehicles/:id/authorizations', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden('Only the owner can lend this vehicle.');
  const phone = normPhone(str(req.body.phone, 'Driver phone', { min: 7, max: 20 }));
  const driver = one('SELECT id, name FROM users WHERE phone = ?', [phone]);
  if (driver?.id === req.user.id) throw bad('You already have full use of your own vehicle.');
  const kind = oneOf(req.body.kind, 'Type', Object.keys(AUTHORIZATION_KINDS));
  const startsAt = isoDate(req.body.starts_at || new Date().toISOString(), 'Start');
  const endsAt = isoDate(req.body.ends_at, 'End', { optional: true });
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw bad('The end must be after the start.');
  if (endsAt && Date.parse(endsAt) <= Date.now()) throw bad('The end is already in the past.');
  if (kind === 'rental' && !endsAt) throw bad('A rental needs an end date and time.');
  const name = driver?.name || str(req.body.name, 'Driver name', { optional: true, max: 80 });
  const id = newId('aut');
  run(`INSERT INTO authorizations (id, vehicle_id, driver_user_id, driver_phone, driver_name, granted_by, kind, starts_at, ends_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, v.id, driver?.id ?? null, phone, name, req.user.id, kind, startsAt, endsAt, str(req.body.note, 'Note', { optional: true, max: 200 })]);
  if (driver) notify({ userId: driver.id, kind: 'authorization', title: `${req.user.name} lent you ${v.make} ${v.model} (${v.plate})`, body: endsAt ? `Until ${endsAt.slice(0, 16).replace('T', ' ')}. Open Drive to start.` : 'Open Drive to start.', vehicleId: v.id, dedupeKey: `auth:${id}:granted` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'authorization.grant', targetType: 'vehicle', targetId: v.id, details: { id, phone, kind, startsAt, endsAt }, ip: req.ip });
  res.status(201).json({ authorization: one('SELECT * FROM authorizations WHERE id = ?', [id]), driverHasAccount: !!driver });
}));

r.get('/vehicles/:id/authorizations', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden();
  res.json({ authorizations: all('SELECT * FROM authorizations WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 50', [v.id]) });
}));

r.post('/authorizations/:id/revoke', h((req, res) => {
  const a = one('SELECT * FROM authorizations WHERE id = ?', [req.params.id]);
  if (!a) throw notFound();
  const v = requireVehicle(a.vehicle_id);
  if (!canManage(req.user, v)) throw forbidden();
  if (a.status !== 'active') throw conflict('This permission has already ended.');
  const now = new Date().toISOString();
  tx(() => {
    run(`UPDATE authorizations SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?`, [now, req.user.id, a.id]);
    // Revoking takes effect at once, even mid-journey: the drive session ends and police stop seeing them as authorised.
    run(`UPDATE drive_sessions SET status = 'ended', ended_at = ?, end_reason = 'revoked' WHERE authorization_id = ? AND status = 'active'`, [now, a.id]);
  });
  if (a.driver_user_id) notify({ userId: a.driver_user_id, kind: 'authorization', severity: 'warn', title: `Permission to drive ${v.plate} was withdrawn`, dedupeKey: `auth:${a.id}:revoked` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'authorization.revoke', targetType: 'vehicle', targetId: v.id, details: { id: a.id }, ip: req.ip });
  res.json({ ok: true });
}));

r.get('/me/authorizations', h((req, res) => {
  const now = new Date().toISOString();
  const rows = all(
    `SELECT a.*, v.plate, v.make, v.model, v.year, v.color, v.vehicle_class, u.name AS owner_name
       FROM authorizations a JOIN vehicles v ON v.id = a.vehicle_id JOIN users u ON u.id = a.granted_by
      WHERE a.driver_user_id = ? AND a.status = 'active' AND (a.ends_at IS NULL OR a.ends_at > ?) ORDER BY a.starts_at ASC`, [req.user.id, now]);
  res.json({ authorizations: rows.map((a) => ({ ...a, current: a.starts_at <= now })) });
}));

/* ---- driving: declare "I am driving this vehicle" ---- */
const sessionOut = (s) => s && ({ ...s, vehicle: one('SELECT id, plate, make, model, year, vehicle_class FROM vehicles WHERE id = ?', [s.vehicle_id]) });

r.get('/drive/current', h((req, res) => {
  res.json({ session: sessionOut(one(`SELECT * FROM drive_sessions WHERE driver_user_id = ? AND status = 'active'`, [req.user.id])) });
}));

r.post('/drive/start', h((req, res) => {
  const v = requireVehicle(str(req.body.vehicle_id, 'Vehicle'));
  const lat = req.body.lat == null ? null : num(req.body.lat, 'Latitude', { min: -90, max: 90 });
  const lng = req.body.lng == null ? null : num(req.body.lng, 'Longitude', { min: -180, max: 180 });

  // On what basis may this person drive it?
  let basis = null; let auth = null;
  if (v.owner_user_id === req.user.id) basis = 'owner';
  else if (canManage(req.user, v) || isFleetDriver(req.user, v)) basis = 'fleet';
  else { auth = activeAuthorization(req.user.id, v.id); if (auth) basis = 'authorization'; }

  const active = openFlagsOn('vehicle', v.id).filter((f) => f.status === 'active' && ['stolen', 'unauthorized_use'].includes(f.kind));
  if (active.length) {
    for (const f of active) recordSighting({ flag: f, vehicle: v, officerId: null, source: 'drive_session', lat, lng, label: 'Attempt to start a drive session' });
    audit({ actor: { id: req.user.id, label: req.user.name }, action: 'drive.blocked_flagged', targetType: 'vehicle', targetId: v.id, details: { basis, lat, lng }, ip: req.ip });
    // The owner is told the truth. Anyone else gets a bland refusal: no hint that police were alerted.
    if (basis === 'owner') throw new HttpError(409, 'This vehicle is on the police stolen list. If you have it back, ask the police to clear it.');
    throw new HttpError(409, 'This vehicle cannot be started right now. Contact the owner.');
  }
  if (!basis) throw forbidden('You do not have permission to drive this vehicle. Ask the owner to lend it to you in Street Code.');

  const lic = one('SELECT * FROM licences WHERE user_id = ?', [req.user.id]);
  const check = checkLicence(lic && { ...lic, classes: json(lic.classes, []), restrictions: json(lic.restrictions, []) }, v.vehicle_class, new Date(), { commercialUse: !!v.commercial_use });
  if (check.level === 'fail') throw forbidden(`Your licence does not allow this: ${check.reasons.join('. ')}.`);

  const mine = one(`SELECT * FROM drive_sessions WHERE driver_user_id = ? AND status = 'active'`, [req.user.id]);
  if (mine && mine.vehicle_id === v.id) return res.json({ session: sessionOut(mine), warnings: check.reasons });
  if (mine) throw conflict('You are already driving another vehicle. End that drive first.');
  const other = one(`SELECT * FROM drive_sessions WHERE vehicle_id = ? AND status = 'active'`, [v.id]);
  if (other) throw conflict('Someone else is currently driving this vehicle.');

  const id = newId('drv');
  run(`INSERT INTO drive_sessions (id, vehicle_id, driver_user_id, authorization_id, basis, started_at, start_odometer, start_lat, start_lng) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, v.id, req.user.id, auth?.id ?? null, basis, new Date().toISOString(), v.odometer, lat, lng]);
  if (basis !== 'owner' && v.owner_user_id) notify({ userId: v.owner_user_id, kind: 'drive', title: `${req.user.name} started driving ${v.plate}`, vehicleId: v.id, dedupeKey: `drv:${id}:start` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'drive.start', targetType: 'vehicle', targetId: v.id, details: { basis }, ip: req.ip });
  res.status(201).json({ session: sessionOut(one('SELECT * FROM drive_sessions WHERE id = ?', [id])), warnings: check.reasons });
}));

r.post('/drive/end', h((req, res) => {
  const s = one(`SELECT * FROM drive_sessions WHERE driver_user_id = ? AND status = 'active'`, [req.user.id]);
  if (!s) throw notFound('You are not driving right now.');
  const v = requireVehicle(s.vehicle_id);
  let endOdo = null;
  if (req.body.end_odometer != null && req.body.end_odometer !== '') {
    endOdo = num(req.body.end_odometer, 'Odometer', { min: 0, max: 5_000_000 });
    if (endOdo > v.odometer) recordOdometer({ vehicle: v, value: endOdo, source: 'driver', user: req.user, ip: req.ip });
  }
  run(`UPDATE drive_sessions SET status = 'ended', ended_at = ?, end_reason = 'driver', end_odometer = ? WHERE id = ?`, [new Date().toISOString(), endOdo, s.id]);
  res.json({ ok: true, distance: endOdo != null ? Math.max(0, endOdo - (s.start_odometer ?? endOdo)) : null });
}));

// The owner can always take a vehicle back
r.post('/vehicles/:id/drive/end', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden();
  run(`UPDATE drive_sessions SET status = 'ended', ended_at = ?, end_reason = 'owner' WHERE vehicle_id = ? AND status = 'active'`, [new Date().toISOString(), v.id]);
  res.json({ ok: true });
}));

export default r;
