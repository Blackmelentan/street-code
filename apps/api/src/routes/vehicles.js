import { Router } from 'express';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, isAdmin, isPolice, membershipIn } from '../middleware/auth.js';
import { h, str, num, oneOf, isoDate, bad, conflict, forbidden, notFound, HttpError, json } from '../lib/http.js';
import { newId, plateKey, normPhone } from '../lib/ids.js';
import { requireVehicle, accessTo, requireAccess, canManage, vehiclesVisibleTo, vehicleStewards } from '../services/access.js';
import { serializeVehicle, vehicleHealth, documentsWithHealth, recordOdometer, addServiceRecord, openFlagsOn, isStolen, recordsOf } from '../services/vehicles.js';
import { appendBlock, getBlocks, verifyChain } from '../services/passport.js';
import { createFlag, clearFlag, flagForOfficer, publicFlag } from '../services/flags.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { VEHICLE_CLASSES, SERVICE_ITEMS, OIL_TYPES, DOCUMENT_KINDS, FUEL_TYPES } from '../../../../packages/core/src/index.js';

const r = Router();
r.use(['/vehicles', '/me/transfers', '/transfers'], authenticate);

const summary = (v, level) => {
  const health = vehicleHealth(v);
  return { ...serializeVehicle(v, { level }), health: { overall: health.overall, next: health.next, counts: health.counts, usage: health.usage, items: health.items.slice(0, 4) } };
};

r.get('/vehicles', h((req, res) => {
  const rows = vehiclesVisibleTo(req.user);
  res.json({ vehicles: rows.map((v) => summary(v, accessTo(req.user, v).level)) });
}));

r.post('/vehicles', h((req, res) => {
  const b = req.body;
  const vin = str(b.vin, 'VIN or chassis number', { min: 6, max: 17 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plate = str(b.plate, 'Plate', { min: 3, max: 14 }).toUpperCase().trim();
  const cls = oneOf(b.vehicle_class || 'car', 'Vehicle type', Object.keys(VEHICLE_CLASSES));
  const year = num(b.year, 'Year', { min: 1950, max: new Date().getFullYear() + 1, int: true });
  const odometer = num(b.odometer ?? 0, 'Odometer', { min: 0, max: 5_000_000 });
  const orgId = b.owner_org_id || null;
  if (orgId) {
    const m = membershipIn(req.user, orgId);
    if (!m || m.org_type !== 'fleet' || !['owner', 'manager'].includes(m.role)) throw forbidden('You cannot add vehicles to that fleet.');
  }
  if (one('SELECT id FROM vehicles WHERE plate_key = ?', [plateKey(plate)])) throw conflict('A vehicle with this plate is already registered.');
  if (one('SELECT id FROM vehicles WHERE vin = ?', [vin])) throw conflict('A vehicle with this VIN is already registered.');
  const id = newId('veh');
  const now = new Date().toISOString();
  tx(() => {
    run(
      `INSERT INTO vehicles (id, vin, plate, plate_key, make, model, year, color, vehicle_class, fuel_type, severe_service, commercial_use, owner_user_id, owner_org_id, odometer, odometer_updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, vin, plate, plateKey(plate), str(b.make, 'Make', { max: 40 }), str(b.model, 'Model', { max: 60 }), year, str(b.color, 'Colour', { optional: true, max: 30 }), cls,
        b.fuel_type ? oneOf(b.fuel_type, 'Fuel', FUEL_TYPES) : null, b.severe_service ? 1 : VEHICLE_CLASSES[cls].severe ? 1 : 0, b.commercial_use ? 1 : 0, orgId ? null : req.user.id, orgId, odometer, now],
    );
    run(`INSERT INTO odometer_readings (id, vehicle_id, value, source, recorded_by, recorded_at) VALUES (?,?,?,?,?,?)`, [newId('odo'), id, odometer, 'owner', req.user.id, now]);
    appendBlock({ vehicleId: id, eventType: 'GENESIS', mileage: odometer, authority: 'system', actor: { id: req.user.id, role: 'owner', name: req.user.name }, description: `Registered on Street Code by ${req.user.name}. Self-declared; not yet verified by a garage.`, payload: { vin, plate, make: b.make, model: b.model, year } });
  });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'vehicle.create', targetType: 'vehicle', targetId: id, ip: req.ip });
  res.status(201).json({ vehicle: summary(one('SELECT * FROM vehicles WHERE id = ?', [id]), 'manage') });
}));

r.get('/vehicles/:id', h((req, res) => {
  const v = requireVehicle(req.params.id);
  const access = requireAccess(req.user, v, 'manage', 'drive', 'garage', 'admin');
  const manage = access.level === 'manage' || access.level === 'admin';
  const health = vehicleHealth(v);
  const out = {
    vehicle: serializeVehicle(v, { level: access.level }),
    health,
    documents: documentsWithHealth(v.id),
    services: recordsOf(v.id).slice(0, 30),
    flags: openFlagsOn('vehicle', v.id).map((f) => publicFlag(f)),
    session: one(`SELECT s.id, s.started_at, s.basis, u.name AS driver_name FROM drive_sessions s JOIN users u ON u.id = s.driver_user_id WHERE s.vehicle_id = ? AND s.status = 'active'`, [v.id]),
  };
  if (manage) {
    out.authorizations = all(`SELECT * FROM authorizations WHERE vehicle_id = ? AND status = 'active' ORDER BY created_at DESC`, [v.id]);
  }
  res.json(out);
}));

r.patch('/vehicles/:id', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden();
  const sev = req.body.severe_service === undefined ? v.severe_service : req.body.severe_service ? 1 : 0;
  const com = req.body.commercial_use === undefined ? v.commercial_use : req.body.commercial_use ? 1 : 0;
  const color = req.body.color === undefined ? v.color : str(req.body.color, 'Colour', { optional: true, max: 30 });
  run('UPDATE vehicles SET severe_service = ?, commercial_use = ?, color = ? WHERE id = ?', [sev, com, color, v.id]);
  res.json({ vehicle: serializeVehicle(requireVehicle(v.id), { level: 'manage' }) });
}));

r.get('/vehicles/:id/health', h((req, res) => {
  const v = requireVehicle(req.params.id);
  requireAccess(req.user, v, 'manage', 'drive', 'garage', 'admin');
  res.json({ health: vehicleHealth(v) });
}));

r.post('/vehicles/:id/odometer', h((req, res) => {
  const v = requireVehicle(req.params.id);
  const a = requireAccess(req.user, v, 'manage', 'drive', 'garage');
  const value = num(req.body.value, 'Odometer', { min: 0, max: 5_000_000 });
  const source = a.level === 'garage' ? 'garage' : a.level === 'drive' ? 'driver' : 'owner';
  recordOdometer({ vehicle: v, value, source, user: req.user, note: str(req.body.note, 'Note', { optional: true, max: 200 }), ip: req.ip });
  res.status(201).json({ vehicle: serializeVehicle(requireVehicle(v.id), { level: a.level }), health: vehicleHealth(requireVehicle(v.id)) });
}));

// Self-logged service (oil change you did yourself, a wash). Shown as "self-reported", never as garage-verified.
r.post('/vehicles/:id/services', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden('Only the owner can log this. Garages log work through a job card.');
  const code = oneOf(req.body.item_code, 'Service item', Object.keys(SERVICE_ITEMS));
  const cls = VEHICLE_CLASSES[v.vehicle_class];
  if (!SERVICE_ITEMS[code].appliesTo(cls)) throw bad(`${SERVICE_ITEMS[code].label} does not apply to a ${cls.label.toLowerCase()}.`);
  const performedAt = isoDate(req.body.performed_at || new Date().toISOString(), 'Date');
  if (Date.parse(performedAt) > Date.now() + 3600000) throw bad('The date cannot be in the future.');
  let product = null;
  if (code === 'engine_oil') {
    product = { oil_type: oneOf(req.body.oil_type, 'Oil type', Object.keys(OIL_TYPES)), grade: str(req.body.oil_grade, 'Oil grade', { optional: true, max: 40 }), brand: str(req.body.brand, 'Brand', { optional: true, max: 40 }), filter_changed: req.body.filter_changed !== false };
  }
  const odometer = req.body.odometer == null || req.body.odometer === '' ? v.odometer : num(req.body.odometer, 'Odometer', { min: 0, max: 5_000_000 });
  if (odometer > v.odometer) recordOdometer({ vehicle: v, value: odometer, source: 'owner', user: req.user, recordedAt: performedAt > new Date().toISOString() ? new Date().toISOString() : performedAt, ip: req.ip });
  const id = addServiceRecord({
    vehicleId: v.id, itemCode: code, performedAt, odometer: Math.min(odometer, Math.max(odometer, 0)), userId: req.user.id, product,
    intervalDistance: req.body.interval_distance ? num(req.body.interval_distance, 'Distance interval', { min: 100, max: 500000 }) : null,
    intervalDays: req.body.interval_days ? num(req.body.interval_days, 'Time interval', { min: 1, max: 3650 }) : null,
    notes: str(req.body.notes, 'Notes', { optional: true, max: 300 }), priceMinor: req.body.price_gmd ? Math.round(num(req.body.price_gmd, 'Price', { min: 0, max: 1_000_000 }) * 100) : null,
  });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'service.self_logged', targetType: 'vehicle', targetId: v.id, details: { code, id }, ip: req.ip });
  const cur = requireVehicle(v.id);
  res.status(201).json({ id, health: vehicleHealth(cur) });
}));

r.put('/vehicles/:id/settings/:item', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden();
  const item = oneOf(req.params.item, 'Item', Object.keys(SERVICE_ITEMS));
  const d = req.body.interval_distance == null || req.body.interval_distance === '' ? null : num(req.body.interval_distance, 'Distance interval', { min: 100, max: 500000 });
  const t = req.body.interval_days == null || req.body.interval_days === '' ? null : num(req.body.interval_days, 'Time interval', { min: 1, max: 3650 });
  run(`INSERT INTO vehicle_service_settings (vehicle_id, item_code, interval_distance, interval_days, enabled) VALUES (?,?,?,?,?)
       ON CONFLICT(vehicle_id, item_code) DO UPDATE SET interval_distance = excluded.interval_distance, interval_days = excluded.interval_days, enabled = excluded.enabled`,
    [v.id, item, d, t, req.body.enabled === false ? 0 : 1]);
  res.json({ health: vehicleHealth(v) });
}));

r.post('/vehicles/:id/documents', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (!canManage(req.user, v)) throw forbidden();
  const kind = oneOf(req.body.kind, 'Document type', Object.keys(DOCUMENT_KINDS));
  const validTo = isoDate(req.body.valid_to, 'Valid until');
  const validFrom = isoDate(req.body.valid_from, 'Valid from', { optional: true });
  const id = newId('doc');
  // Self-declared documents start "pending". An officer sees them as unverified until the issuer or an administrator confirms.
  run(`INSERT INTO vehicle_documents (id, vehicle_id, kind, number, issuer, valid_from, valid_to, status, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, v.id, kind, str(req.body.number, 'Number', { optional: true, max: 40 }), str(req.body.issuer, 'Issuer', { optional: true, max: 80 }), validFrom, validTo, 'pending', req.user.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'document.add', targetType: 'vehicle', targetId: v.id, details: { kind, id }, ip: req.ip });
  res.status(201).json({ documents: documentsWithHealth(v.id) });
}));

r.get('/vehicles/:id/passport', h((req, res) => {
  const v = requireVehicle(req.params.id);
  requireAccess(req.user, v, 'manage', 'drive', 'garage', 'admin');
  res.json({ blocks: getBlocks(v.id), verification: verifyChain(v.id) });
}));

/* ---- report stolen: starts as an unconfirmed report until an officer confirms it ---- */
r.post('/vehicles/:id/report-stolen', h((req, res) => {
  const v = requireVehicle(req.params.id);
  const flag = createFlag({
    user: req.user, subjectType: 'vehicle', subjectId: v.id, kind: 'stolen', ownerReport: true, ip: req.ip,
    summary: str(req.body.summary, 'What happened', { min: 5, max: 200 }), detail: str(req.body.detail, 'Detail', { optional: true, max: 1000 }), caseRef: str(req.body.case_ref, 'Police report number', { optional: true, max: 40 }),
  });
  notify({ userId: req.user.id, kind: 'flag', severity: 'warn', title: `Stolen report filed for ${v.plate}`, body: 'Officers can now see it. Go to a police station to confirm it and get it on the active list.', vehicleId: v.id, dedupeKey: `flag:${flag.id}:filed` });
  res.status(201).json({ flag: publicFlag(flag) });
}));

// An owner can withdraw their own report while it is still unconfirmed. Once police confirm it, only police can lift it.
r.post('/vehicles/:id/report-stolen/withdraw', h((req, res) => {
  const v = requireVehicle(req.params.id);
  const f = one(`SELECT * FROM flags WHERE subject_type = 'vehicle' AND subject_id = ? AND kind = 'stolen' AND reported_by_owner = 1 AND status IN ('reported','active') ORDER BY created_at DESC LIMIT 1`, [v.id]);
  if (!f || !canManage(req.user, v)) throw notFound('There is no open report on this vehicle.'); // strangers learn nothing
  if (f.status === 'active') throw forbidden('Police have confirmed this report, so only police can clear it. Contact the station.');
  res.json({ flag: publicFlag(clearFlag({ user: req.user, id: f.id, reason: str(req.body.reason, 'Reason', { min: 3, max: 200 }), ip: req.ip })) });
}));

/* ---- ownership transfer: seller offers, buyer accepts. A flagged vehicle cannot be transferred. ---- */
r.post('/vehicles/:id/transfer', h((req, res) => {
  const v = requireVehicle(req.params.id);
  if (v.owner_user_id !== req.user.id) throw forbidden('Only the registered owner can sell this vehicle.');
  if (openFlagsOn('vehicle', v.id).length) throw conflict('A vehicle with an open police flag cannot be transferred.');
  const phone = normPhone(str(req.body.to_phone, 'Buyer phone', { min: 7 }));
  const to = one('SELECT id FROM users WHERE phone = ?', [phone]);
  if (to?.id === req.user.id) throw bad('You cannot sell a vehicle to yourself.');
  if (one(`SELECT id FROM ownership_transfers WHERE vehicle_id = ? AND status = 'offered'`, [v.id])) throw conflict('There is already a transfer waiting for the buyer.');
  const id = newId('trf');
  run(`INSERT INTO ownership_transfers (id, vehicle_id, from_user_id, to_user_id, to_phone, odometer, price_minor) VALUES (?,?,?,?,?,?,?)`,
    [id, v.id, req.user.id, to?.id ?? null, phone, v.odometer, req.body.price_gmd ? Math.round(num(req.body.price_gmd, 'Price', { min: 0, max: 100_000_000 }) * 100) : null]);
  if (to) notify({ userId: to.id, kind: 'transfer', severity: 'info', title: `${req.user.name} is transferring ${v.plate} to you`, body: 'Check the vehicle history, then accept.', vehicleId: v.id, dedupeKey: `trf:${id}` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'transfer.offer', targetType: 'vehicle', targetId: v.id, details: { id }, ip: req.ip });
  res.status(201).json({ transfer: one('SELECT * FROM ownership_transfers WHERE id = ?', [id]) });
}));

r.get('/me/transfers', h((req, res) => {
  res.json({ incoming: all(`SELECT t.*, v.plate, v.make, v.model, v.year, u.name AS from_name FROM ownership_transfers t JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = t.from_user_id WHERE t.to_user_id = ? AND t.status = 'offered'`, [req.user.id]),
    outgoing: all(`SELECT t.*, v.plate FROM ownership_transfers t JOIN vehicles v ON v.id = t.vehicle_id WHERE t.from_user_id = ? AND t.status = 'offered'`, [req.user.id]) });
}));

r.post('/transfers/:id/:action', h((req, res) => {
  const t = one('SELECT * FROM ownership_transfers WHERE id = ?', [req.params.id]);
  if (!t) throw notFound();
  if (t.status !== 'offered') throw conflict('This transfer is already closed.');
  const action = oneOf(req.params.action, 'Action', ['accept', 'decline', 'cancel']);
  if (action === 'cancel') {
    if (t.from_user_id !== req.user.id) throw forbidden();
    run(`UPDATE ownership_transfers SET status = 'cancelled' WHERE id = ?`, [t.id]);
  } else {
    if (t.to_user_id !== req.user.id) throw forbidden('This transfer is not addressed to you.');
    if (action === 'decline') run(`UPDATE ownership_transfers SET status = 'declined' WHERE id = ?`, [t.id]);
    else tx(() => {
      const v = requireVehicle(t.vehicle_id);
      if (openFlagsOn('vehicle', v.id).length) throw conflict('This vehicle now has an open police flag and cannot be transferred.');
      const now = new Date().toISOString();
      run('UPDATE vehicles SET owner_user_id = ?, owner_org_id = NULL WHERE id = ?', [req.user.id, v.id]);
      // The old owner's lending arrangements and any drive session end with the sale.
      run(`UPDATE authorizations SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE vehicle_id = ? AND status = 'active'`, [now, req.user.id, v.id]);
      run(`UPDATE drive_sessions SET status = 'ended', ended_at = ?, end_reason = 'ownership_transfer' WHERE vehicle_id = ? AND status = 'active'`, [now, v.id]);
      run(`UPDATE ownership_transfers SET status = 'completed', completed_at = ? WHERE id = ?`, [now, t.id]);
      const from = one('SELECT name FROM users WHERE id = ?', [t.from_user_id]);
      appendBlock({ vehicleId: v.id, eventType: 'OWNERSHIP_TRANSFER', mileage: v.odometer, authority: 'system', actor: { id: req.user.id, role: 'system', name: 'Street Code' }, description: `Ownership passed from ${from.name} to ${req.user.name}.`, payload: { from: t.from_user_id, to: req.user.id, price_minor: t.price_minor } });
      audit({ actor: { id: req.user.id, label: req.user.name }, action: 'transfer.complete', targetType: 'vehicle', targetId: v.id, details: { id: t.id }, ip: req.ip });
      notify({ userId: t.from_user_id, kind: 'transfer', title: `${v.plate} has been transferred`, body: `${req.user.name} accepted.`, vehicleId: v.id, dedupeKey: `trf:${t.id}:done` });
    });
  }
  res.json({ transfer: one('SELECT * FROM ownership_transfers WHERE id = ?', [t.id]) });
}));

export default r;
