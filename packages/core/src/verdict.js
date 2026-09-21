/**
 * Licence eligibility and the roadside verdict.
 *
 * The verdict is what lets an officer check a vehicle from a plate alone:
 * documents, flags, who is declared as driving and on what authority, whether
 * that person's licence covers this vehicle. It is computed on the server, and
 * this module is pure so the rules can be tested without a database.
 */
import { VEHICLE_CLASSES, DOCUMENT_KINDS, LICENCE_GROUPS, requiredLicenceGroup } from './catalog.js';
import { computeDocumentHealth } from './service-engine.js';

const toMs = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));

/** Which licence group does this vehicle need? Kept as a string for callers that only want the letter. */
export function requiredLicenceClass(vehicleClass, commercialUse = false) {
  return requiredLicenceGroup(vehicleClass, commercialUse).group;
}

/**
 * Can this licence holder drive this vehicle right now?
 * A group mismatch is a failure only where the mapping is confirmed; where it is our
 * best reading, it is a warning to verify (never tell an officer to act on a guess).
 * @returns {{ok:boolean, level:'ok'|'warn'|'fail', reasons:string[], required:string}}
 */
export function checkLicence(licence, vehicleClass, now = new Date(), { commercialUse = false } = {}) {
  const { group: required, confidence } = requiredLicenceGroup(vehicleClass, commercialUse);
  const reasons = [];
  if (!licence) return { ok: false, level: 'fail', reasons: ['No driving licence on file'], required };

  let level = 'ok';
  const fail = (m) => { reasons.push(m); level = 'fail'; };
  const warn = (m) => { reasons.push(m); if (level === 'ok') level = 'warn'; };

  if (licence.status === 'suspended') fail('Licence is suspended');
  else if (licence.status === 'revoked') fail('Licence is revoked');
  else if (licence.status === 'pending') warn('Licence has not been verified by the licensing authority yet');

  if (licence.expires_at && toMs(licence.expires_at) < toMs(now)) fail('Licence has expired');

  const groups = Array.isArray(licence.classes) ? licence.classes : [];
  if (!groups.includes(required)) {
    const msg = `Licence does not cover group ${required} (${LICENCE_GROUPS[required]?.label}) needed for a ${VEHICLE_CLASSES[vehicleClass]?.label || vehicleClass}${commercialUse ? ' in commercial use' : ''}`;
    if (confidence === 'confirmed') fail(msg); else warn(`${msg}. Verify: this vehicle type's group is not confirmed`);
  }

  // Resident-permit holders need yearly police clearance to hold a commercial licence.
  if (required === 'C' && licence.commercial_clearance_until && toMs(licence.commercial_clearance_until) < toMs(now)) {
    fail('Commercial clearance has expired');
  }

  const restrictions = Array.isArray(licence.restrictions) ? licence.restrictions : [];
  if (restrictions.length) warn(`Restrictions: ${restrictions.join(', ')}`);

  return { ok: level !== 'fail', level, reasons, required };
}

/**
 * Build the roadside verdict.
 *
 * @param {object} i
 * @param {object} i.vehicle
 * @param {object[]} i.documents           rows from vehicle_documents
 * @param {object[]} i.flags               active flags on the vehicle
 * @param {object[]} i.personFlags         active flags on the declared driver
 * @param {object|null} i.session          active drive session { driver_name, driver_user_id, started_at }
 * @param {object|null} i.authorization    the authorization backing the session, if the driver is not the owner
 * @param {boolean} i.driverIsOwner
 * @param {object|null} i.driverLicence
 * @param {object|null} i.suppliedLicence  licence resolved from a scanned/typed code (overrides driver's)
 * @param {number} i.openCitations
 * @param {object|null} i.health           computeVehicleHealth output (optional)
 */
export function buildVerdict(i, now = new Date()) {
  const checks = [];
  const add = (id, label, state, detail = '') => checks.push({ id, label, state, detail });

  /* ---- documents ---- */
  for (const kind of Object.keys(DOCUMENT_KINDS)) {
    const label = DOCUMENT_KINDS[kind].label;
    const doc = latestDoc(i.documents, kind);
    if (!doc) { add(kind, label, 'warn', 'Nothing on file'); continue; }
    const h = computeDocumentHealth(doc, now);
    if (h.state === 'expired') add(kind, label, 'fail', `Expired ${-h.remainingDays} day${-h.remainingDays === 1 ? '' : 's'} ago`);
    else if (h.state === 'expiring') add(kind, label, 'warn', `Expires in ${h.remainingDays} day${h.remainingDays === 1 ? '' : 's'}`);
    else add(kind, label, 'pass', `Valid to ${String(doc.valid_to).slice(0, 10)}`);
  }

  /* ---- who is driving, and on what authority ---- */
  const session = i.session || null;
  const licence = i.suppliedLicence || i.driverLicence || null;
  if (!session && !i.suppliedLicence) {
    add('driver', 'Declared driver', 'warn', 'Nobody has declared they are driving this vehicle. Identity cannot be confirmed without stopping it.');
  } else {
    const name = session?.driver_name || i.suppliedLicence?.holder_name || 'Unknown';
    if (i.driverIsOwner) {
      add('driver', 'Declared driver', 'pass', `${name} (registered owner)`);
    } else if (i.authorization) {
      const until = i.authorization.ends_at ? `until ${String(i.authorization.ends_at).slice(0, 16).replace('T', ' ')}` : 'open-ended';
      add('driver', 'Declared driver', 'pass', `${name}, authorised by the owner (${i.authorization.kind}), ${until}`);
    } else if (session) {
      add('driver', 'Declared driver', 'fail', `${name} is driving but has no current authorisation from the owner`);
    } else {
      add('driver', 'Declared driver', 'warn', `Licence presented for ${name}, but they have not declared driving this vehicle`);
    }

    const lc = checkLicence(licence, i.vehicle.vehicle_class, now, { commercialUse: !!i.vehicle.commercial_use });
    if (lc.level === 'ok') add('licence', 'Driving licence', 'pass', `Valid, covers group ${lc.required}`);
    else add('licence', 'Driving licence', lc.level === 'fail' ? 'fail' : 'warn', lc.reasons.join('. '));
  }

  /* ---- outstanding items ---- */
  add('citations', 'Unpaid citations', i.openCitations > 0 ? 'warn' : 'pass', i.openCitations > 0 ? `${i.openCitations} open` : 'None');

  const overdueSafety = (i.health?.items || []).filter((x) => x.critical && (x.status === 'overdue' || x.status === 'critical'));
  if (overdueSafety.length) add('safety', 'Safety servicing', 'warn', `Overdue: ${overdueSafety.map((x) => x.short).join(', ')}`);

  /* ---- flags ---- */
  const vehicleHits = (i.flags || []).filter((f) => f.status === 'active' || f.status === 'reported');
  const personHits = (i.personFlags || []).filter((f) => f.status === 'active');
  const hits = [...vehicleHits.map((f) => ({ ...f, on: 'vehicle' })), ...personHits.map((f) => ({ ...f, on: 'person' }))];

  /* ---- outcome ---- */
  const redHit = hits.some((f) => f.level === 'red' && f.status === 'active');
  const anyHit = hits.length > 0;
  const anyFail = checks.some((c) => c.state === 'fail');
  const anyWarn = checks.some((c) => c.state === 'warn');

  let outcome = 'clear';
  if (redHit) outcome = 'flag_hit';
  else if (anyHit || anyFail) outcome = 'action_required';
  else if (anyWarn) outcome = 'advisory';

  const topFlag = hits.sort(byLevel)[0] || null;
  const headline = {
    flag_hit: 'Flag match. Follow the instruction below.',
    action_required: 'Action required.',
    advisory: 'No blocking issues, but there are things to note.',
    clear: 'Clear. Nothing to act on.',
  }[outcome];

  return {
    outcome,
    headline,
    instruction: topFlag?.instruction || null,
    checks,
    flags: hits.map((f) => ({ id: f.id, on: f.on, kind: f.kind, level: f.level, status: f.status, summary: f.summary, instruction: f.instruction })),
  };
}

const LEVEL_RANK = { red: 0, amber: 1, watch: 2 };
const byLevel = (a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);

function latestDoc(docs, kind) {
  return (docs || [])
    .filter((d) => d.kind === kind && d.status !== 'rejected')
    .sort((a, b) => toMs(b.valid_to) - toMs(a.valid_to))[0];
}
