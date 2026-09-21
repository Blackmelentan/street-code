import { all, one, run } from '../db/database.js';
import { buildVerdict, checkLicence, VEHICLE_CLASSES } from '../../../../packages/core/src/index.js';
import { newId, plateKey } from '../lib/ids.js';
import { json } from '../lib/http.js';
import { stationOf } from '../middleware/auth.js';
import { resolveLicenceCode } from './licence-code.js';
import { vehicleHealth, documentsOf, openFlagsOn, ownerLabel } from './vehicles.js';
import { activeAuthorization } from './access.js';
import { recordSighting, flagForOfficer } from './flags.js';
import { audit } from './audit.js';

const parseLicence = (l) => (l ? { ...l, classes: json(l.classes, []), restrictions: json(l.restrictions, []) } : null);

/** What an officer may see about a licence: enough to decide, nothing to misuse. */
const licenceView = (l, vehicleClass, commercialUse, now) => {
  if (!l) return null;
  const check = checkLicence(l, vehicleClass, now, { commercialUse });
  return { number: l.licence_number, holder: l.holder_name, groups: l.classes, expires_at: l.expires_at, status: l.status, points: l.points, restrictions: l.restrictions, covers_vehicle: check.level !== 'fail', level: check.level, required: check.required };
};

function logCheck({ user, subjectKind, query, vehicleId = null, licenceId = null, reason, caseRef, location, outcome, verdict, ip }) {
  const st = stationOf(user);
  const id = newId('chk');
  run(
    `INSERT INTO police_checks (id, officer_id, org_id, badge, subject_kind, query, vehicle_id, licence_id, reason, case_ref, lat, lng, location_label, outcome, verdict)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, user.id, st?.org_id ?? null, st?.badge_number ?? null, subjectKind, query, vehicleId, licenceId, reason, caseRef || null, location?.lat ?? null, location?.lng ?? null, location?.label ?? null, outcome, JSON.stringify(verdict)],
  );
  audit({ actor: { id: user.id, label: user.name }, action: `police.check.${subjectKind}`, targetType: subjectKind === 'vehicle' ? 'vehicle' : 'licence', targetId: vehicleId || licenceId, details: { check: id, reason, outcome, query: subjectKind === 'vehicle' ? query : '(licence code)' }, ip });
  return id;
}

/**
 * Check a vehicle from a plate or VIN. No conversation with the driver is required:
 * documents, who has declared they are driving and on whose authority, licence cover,
 * open citations and flags on the vehicle and on the declared driver.
 */
export function verifyVehicle({ user, query, reason, caseRef, location, licenceCode, ip, now = new Date() }) {
  const key = plateKey(query);
  const v = one('SELECT * FROM vehicles WHERE plate_key = ? OR vin = ?', [key, key]);

  if (!v) {
    const verdict = { outcome: 'unregistered', headline: 'No vehicle is registered under this plate or VIN.', instruction: null, checks: [{ id: 'registration', label: 'Registration', state: 'fail', detail: 'Not found in Street Code. It may be unregistered, or the plate may be mis-read.' }], flags: [] };
    const checkId = logCheck({ user, subjectKind: 'vehicle', query, reason, caseRef, location, outcome: 'unregistered', verdict, ip });
    return { checkId, verdict, vehicle: null, driver: null };
  }

  const session = one(
    `SELECT s.*, u.name AS driver_name FROM drive_sessions s JOIN users u ON u.id = s.driver_user_id WHERE s.vehicle_id = ? AND s.status = 'active'`, [v.id],
  );
  const authorization = session?.authorization_id ? one('SELECT * FROM authorizations WHERE id = ?', [session.authorization_id]) : null;
  const driverIsOwner = !!session && session.basis === 'owner';
  const driverLicence = session ? parseLicence(one('SELECT l.*, u.name AS holder_name FROM licences l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?', [session.driver_user_id])) : null;

  let suppliedLicence = null;
  let codeProblem = false;
  if (licenceCode) {
    suppliedLicence = parseLicence(resolveLicenceCode(licenceCode));
    if (!suppliedLicence) codeProblem = true;
  }

  const personIds = [...new Set([session?.driver_user_id, suppliedLicence?.user_id].filter(Boolean))];
  // A flag awaiting approval must never reach a roadside stop. Person flags act only once active (a second
  // person has approved them). Vehicle flags act when active, or when the OWNER reported it (shown as unconfirmed).
  const personFlags = personIds.flatMap((id) => openFlagsOn('person', id)).filter((f) => f.status === 'active');
  const flags = openFlagsOn('vehicle', v.id).filter((f) => f.status === 'active' || f.reported_by_owner);
  const openCitations = one(`SELECT COUNT(*) AS n FROM citations WHERE vehicle_id = ? AND status = 'issued'`, [v.id]).n;
  const health = vehicleHealth(v, now);

  const verdict = buildVerdict({
    vehicle: v, documents: documentsOf(v.id), flags, personFlags, session, authorization, driverIsOwner,
    driverLicence, suppliedLicence, openCitations, health,
  }, now);

  if (codeProblem) {
    verdict.checks.push({ id: 'licence_code', label: 'Licence code', state: 'warn', detail: 'The code was not recognised or has expired. Ask the driver for the current code.' });
    if (verdict.outcome === 'clear') { verdict.outcome = 'advisory'; verdict.headline = 'No blocking issues, but there are things to note.'; }
  }

  const checkId = logCheck({ user, subjectKind: 'vehicle', query, vehicleId: v.id, reason, caseRef, location, outcome: verdict.outcome, verdict, ip });

  // Silent hits: record a sighting for every flag that matched. The driver is never shown this.
  for (const f of [...flags, ...personFlags]) {
    if (f.status === 'active' || f.reported_by_owner) recordSighting({ flag: f, vehicle: v, officerId: user.id, source: 'police_check', lat: location?.lat, lng: location?.lng, label: location?.label });
  }

  const cls = VEHICLE_CLASSES[v.vehicle_class] || VEHICLE_CLASSES.car;
  const officerFlags = [...flags, ...personFlags].map((f) => flagForOfficer(f, user));
  const driver = session || suppliedLicence ? {
    name: session?.driver_name || suppliedLicence?.holder_name,
    declared: !!session,
    basis: session?.basis ?? null,
    since: session?.started_at ?? null,
    authorization: authorization ? { kind: authorization.kind, ends_at: authorization.ends_at, note: authorization.note } : null,
    licence: licenceView(suppliedLicence || driverLicence, v.vehicle_class, !!v.commercial_use, now),
  } : null;

  return {
    checkId,
    verdict,
    vehicle: { id: v.id, plate: v.plate, vin: v.vin, make: v.make, model: v.model, year: v.year, color: v.color, class_label: cls.label, commercial: !!v.commercial_use, registered_owner: ownerLabel(v), status: v.status, odometer: v.odometer, unit: cls.unit },
    driver,
    flags: officerFlags,
    health: { overall: health.overall, overdue: health.items.filter((i) => i.critical && (i.status === 'overdue' || i.status === 'critical')).map((i) => i.short) },
  };
}

/** Check a person by their live licence code. */
export function verifyLicenceCode({ user, code, reason, caseRef, location, ip, now = new Date() }) {
  const licence = parseLicence(resolveLicenceCode(code));
  if (!licence) {
    const verdict = { outcome: 'action_required', headline: 'The code was not recognised or has expired.', checks: [{ id: 'licence_code', label: 'Licence code', state: 'fail', detail: 'Ask the driver to refresh the code in their app, or check the licence number.' }], flags: [], instruction: null };
    const checkId = logCheck({ user, subjectKind: 'licence', query: '(licence code)', reason, caseRef, location, outcome: 'action_required', verdict, ip });
    return { checkId, verdict, licence: null };
  }
  const flags = openFlagsOn('person', licence.user_id).filter((f) => f.status === 'active'); // pending flags never act
  const activeSessions = all(`SELECT s.started_at, v.plate, v.make, v.model FROM drive_sessions s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.driver_user_id = ? AND s.status = 'active'`, [licence.user_id]);
  const lc = checkLicence(licence, 'car', now);
  const checks = [];
  const bad = ['suspended', 'revoked'].includes(licence.status) || Date.parse(licence.expires_at) < now.getTime();
  checks.push({ id: 'licence', label: 'Driving licence', state: bad ? 'fail' : licence.status === 'pending' ? 'warn' : 'pass', detail: bad ? lc.reasons.join('. ') : `Group${licence.classes.length > 1 ? 's' : ''} ${licence.classes.join(', ')}, valid to ${licence.expires_at.slice(0, 10)}` });
  if (licence.points > 0) checks.push({ id: 'points', label: 'Penalty points', state: licence.points >= 10 ? 'warn' : 'pass', detail: `${licence.points} on record` });
  const hasRed = flags.some((f) => f.status === 'active' && f.level === 'red');
  const outcome = hasRed ? 'flag_hit' : flags.length || checks.some((c) => c.state === 'fail') ? 'action_required' : checks.some((c) => c.state === 'warn') ? 'advisory' : 'clear';
  const verdict = { outcome, headline: { flag_hit: 'Flag match. Follow the instruction below.', action_required: 'Action required.', advisory: 'Things to note.', clear: 'Clear. Nothing to act on.' }[outcome], instruction: flags[0]?.instruction || null, checks, flags: flags.map((f) => ({ id: f.id, on: 'person', kind: f.kind, level: f.level, status: f.status, summary: f.summary, instruction: f.instruction })) };
  const checkId = logCheck({ user, subjectKind: 'licence', query: '(licence code)', licenceId: licence.id, reason, caseRef, location, outcome, verdict, ip });
  for (const f of flags) if (f.status === 'active') recordSighting({ flag: f, officerId: user.id, source: 'police_check', lat: location?.lat, lng: location?.lng, label: location?.label });
  return {
    checkId, verdict,
    licence: { number: licence.licence_number, holder: licence.holder_name, groups: licence.classes, status: licence.status, expires_at: licence.expires_at, points: licence.points, restrictions: licence.restrictions },
    declaredVehicles: activeSessions,
    flags: flags.map((f) => flagForOfficer(f, user)),
  };
}
