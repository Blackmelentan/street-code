import { all, one, run, tx } from '../db/database.js';
import { computeVehicleHealth, computeDocumentHealth, VEHICLE_CLASSES, MAX_ODOMETER_JUMP_PER_DAY } from '../../../../packages/core/src/index.js';
import { newId } from '../lib/ids.js';
import { HttpError, json } from '../lib/http.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { vehicleStewards } from './access.js';

export const readingsOf = (vehicleId) => all('SELECT value, recorded_at, status, source FROM odometer_readings WHERE vehicle_id = ? ORDER BY recorded_at ASC', [vehicleId]);
export const recordsOf = (vehicleId) => all('SELECT * FROM service_records WHERE vehicle_id = ? ORDER BY performed_at DESC', [vehicleId]).map((r) => ({ ...r, product: json(r.product, null), verified: !!r.verified }));
export const settingsOf = (vehicleId) => all('SELECT * FROM vehicle_service_settings WHERE vehicle_id = ?', [vehicleId]);
export const documentsOf = (vehicleId) => all('SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY valid_to DESC', [vehicleId]);

export function vehicleHealth(v, now = new Date()) {
  return computeVehicleHealth({ vehicle: v, readings: readingsOf(v.id), records: recordsOf(v.id), settings: settingsOf(v.id), now });
}

export const documentsWithHealth = (vehicleId, now = new Date()) =>
  documentsOf(vehicleId).map((d) => ({ ...d, health: computeDocumentHealth(d, now) }));

/** Flags currently in force (or awaiting confirmation) on a vehicle. */
export const openFlagsOn = (subjectType, subjectId) =>
  all(`SELECT * FROM flags WHERE subject_type = ? AND subject_id = ? AND status IN ('reported','active')`, [subjectType, subjectId]);

export const isStolen = (vehicleId) => openFlagsOn('vehicle', vehicleId).some((f) => f.kind === 'stolen');

export function ownerLabel(v) {
  if (v.owner_org_id) return one('SELECT name FROM orgs WHERE id = ?', [v.owner_org_id])?.name || 'Fleet';
  return one('SELECT name FROM users WHERE id = ?', [v.owner_user_id])?.name || 'Unknown';
}

/** Shape a vehicle for the owner / an authorised driver. Never includes other people's contact details. */
export function serializeVehicle(v, { level = 'manage' } = {}) {
  const cls = VEHICLE_CLASSES[v.vehicle_class] || VEHICLE_CLASSES.car;
  const open = openFlagsOn('vehicle', v.id);
  return {
    id: v.id, vin: v.vin, plate: v.plate, make: v.make, model: v.model, year: v.year, color: v.color,
    vehicle_class: v.vehicle_class, class_label: cls.label, unit: cls.unit, icon: cls.icon,
    fuel_type: v.fuel_type, severe_service: !!v.severe_service, commercial_use: !!v.commercial_use,
    status: v.status, odometer: v.odometer, odometer_updated_at: v.odometer_updated_at,
    stolen: open.some((f) => f.kind === 'stolen'),
    access: level,
  };
}

/**
 * Odometer rules. A reading below the highest accepted value is a rollback attempt; an impossible
 * jump is a typo or fraud. Both are refused, and the refusal itself is recorded (as an anomaly row,
 * an audit entry and a notification to the owner).
 *
 * IMPORTANT: the evidence must be written OUTSIDE any transaction that is about to fail. An earlier
 * version recorded the anomaly and then threw inside the same transaction, so the rollback erased
 * the record of the very attempt it was refusing. Callers that wrap odometer changes in a
 * transaction must call guardOdometer() first, before opening it.
 */
export function guardOdometer({ vehicle, value, source, user, recordedAt = new Date().toISOString(), ip = null }) {
  const v = one('SELECT * FROM vehicles WHERE id = ?', [vehicle.id]);
  const last = one(`SELECT value, recorded_at FROM odometer_readings WHERE vehicle_id = ? AND status = 'accepted' ORDER BY value DESC LIMIT 1`, [v.id]);
  const highest = Math.max(v.odometer || 0, last?.value || 0);
  let problem = null;
  if (value < highest) problem = { code: 'rollback', status: 409, msg: `Reading of ${value} is lower than the recorded ${highest}. Odometers only go up.` };
  else if (last) {
    const days = Math.max(1, (Date.parse(recordedAt) - Date.parse(last.recorded_at)) / 86400000);
    if ((value - last.value) / days > MAX_ODOMETER_JUMP_PER_DAY && value - last.value > 2000) {
      problem = { code: 'impossible_jump', status: 422, msg: `A jump of ${Math.round(value - last.value)} in ${Math.round(days)} day(s) is not possible. Check the number and try again.` };
    }
  }
  if (!problem) return;
  run(`INSERT INTO odometer_readings (id, vehicle_id, value, source, recorded_by, recorded_at, status, note) VALUES (?,?,?,?,?,?,?,?)`,
    [newId('odo'), v.id, value, source, user?.id, recordedAt, 'anomaly', problem.msg]);
  audit({ actor: { id: user?.id, label: user?.name || 'system' }, action: `odometer.${problem.code}`, targetType: 'vehicle', targetId: v.id, details: { value, highest, source }, ip });
  const hour = new Date().toISOString().slice(0, 13);
  for (const id of vehicleStewards(v)) {
    notify({ userId: id, kind: 'odometer', severity: 'urgent', title: `Odometer problem on ${v.plate}`, body: problem.msg, vehicleId: v.id, dedupeKey: `odo:${v.id}:${problem.code}:${hour}` });
  }
  throw new HttpError(problem.status, problem.msg, { code: problem.code, highest });
}

export function recordOdometer({ vehicle, value, source, user, recordedAt = new Date().toISOString(), note = null, ip = null }) {
  guardOdometer({ vehicle, value, source, user, recordedAt, ip });
  return tx(() => {
    const id = newId('odo');
    run(`INSERT INTO odometer_readings (id, vehicle_id, value, source, recorded_by, recorded_at, status, note) VALUES (?,?,?,?,?,?,?,?)`, [id, vehicle.id, value, source, user?.id, recordedAt, 'accepted', note]);
    run('UPDATE vehicles SET odometer = ?, odometer_updated_at = ? WHERE id = ?', [value, recordedAt, vehicle.id]);
    return { id, value };
  });
}

export function addServiceRecord({ vehicleId, itemCode, performedAt, odometer, userId, orgId = null, product = null, intervalDistance = null, intervalDays = null, notes = null, priceMinor = null, jobId = null, passportBlockId = null, verified = false }) {
  const id = newId('svc');
  run(
    `INSERT INTO service_records (id, vehicle_id, item_code, performed_at, odometer, performed_by, org_id, product, interval_distance, interval_days, notes, price_minor, job_id, passport_block_id, verified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, vehicleId, itemCode, performedAt, odometer, userId, orgId, product ? JSON.stringify(product) : null, intervalDistance, intervalDays, notes, priceMinor, jobId, passportBlockId, verified ? 1 : 0],
  );
  return id;
}
