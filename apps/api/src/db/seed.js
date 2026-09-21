/**
 * Demo data. Uses the real services (not raw inserts) wherever a rule matters, so the demo
 * can never show a state that production would refuse.
 */
import bcrypt from 'bcryptjs';
import { run, one, tx } from './database.js';
import { newId, plateKey } from '../lib/ids.js';
import { loadUser } from '../middleware/auth.js';
import { appendBlock } from '../services/passport.js';
import { addServiceRecord } from '../services/vehicles.js';
import { createFlag, approveFlag } from '../services/flags.js';
import { verifyVehicle } from '../services/verify.js';
import { runAlerts } from '../services/scheduler.js';
import { audit } from '../services/audit.js';

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();
export const DEMO_PASSWORD = 'streetcode';

export function seed({ log = () => {} } = {}) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 8);
  const U = {};
  const user = (key, name, phone, role = 'user') => { const id = newId('usr'); run('INSERT INTO users (id, name, phone, password_hash, platform_role) VALUES (?,?,?,?,?)', [id, name, phone, hash, role]); U[key] = id; return id; };

  user('fatou', 'Fatou Jallow', '+2207000001');
  user('lamin', 'Lamin Ceesay', '+2207000002');
  user('ebrima', 'Ebrima Sanneh', '+2207000003');
  user('modou', 'Modou Bah', '+2207000004');
  user('ousman', 'Ousman Darboe', '+2207000005');
  user('isatou', 'Isatou Ceesay', '+2207000006');
  user('admin', 'Street Code Admin', '+2207000007', 'admin');
  user('alieu', 'Alieu Bojang', '+2207000008');
  user('mariama', 'Mariama Touray', '+2207000009');
  user('samba', 'Samba Jatta', '+2207000010');

  /* ---- organisations ---- */
  const org = (key, type, name, location, extra = {}) => {
    const id = newId('org');
    run(`INSERT INTO orgs (id, type, name, location, address, phone, rating, bays, occupied_bays, specialties, status, verified_by, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, type, name, location, extra.address ?? null, extra.phone ?? null, extra.rating ?? null, extra.bays ?? 0, extra.occupied ?? 0, JSON.stringify(extra.specialties ?? []), 'verified', U.admin, U.admin]);
    U[key] = id; return id;
  };
  org('kairaba', 'garage', 'Kairaba Auto Works', 'Kairaba Avenue, Serrekunda', { address: 'Kairaba Avenue', phone: '+2203301001', rating: 4.8, bays: 6, occupied: 4, specialties: ['Toyota', 'Diagnostics', 'Brakes'] });
  org('brikama', 'garage', 'Brikama Motors and Tyres', 'Brikama', { address: 'Brikama Highway', phone: '+2203301002', rating: 4.5, bays: 3, occupied: 1, specialties: ['Tyres', 'Motorbikes', 'Tractors'] });
  org('shine', 'carwash', 'Shine Car Wash', 'Bakau', { phone: '+2203301003', rating: 4.6, bays: 4, occupied: 2, specialties: ['Full wash', 'Valet'] });
  org('serrekunda_ps', 'station', 'Serrekunda Police Station', 'Serrekunda');

  const member = (org_, user_, role, employment, badge = null) =>
    run(`INSERT INTO memberships (id, org_id, user_id, role, employment, badge_number, status, started_at) VALUES (?,?,?,?,?,?,?,?)`, [newId('mem'), org_, user_, role, employment, badge, 'active', ago(200)]);
  member(U.kairaba, U.ebrima, 'owner', 'owner');       // the boss
  member(U.kairaba, U.modou, 'mechanic', 'employee');  // works for the boss...
  member(U.brikama, U.modou, 'owner', 'owner');        // ...and owns his own garage
  member(U.serrekunda_ps, U.isatou, 'supervisor', 'employee', 'GPF-1187');
  member(U.serrekunda_ps, U.ousman, 'officer', 'employee', 'GPF-2231');
  // A staff invitation for someone who has no account yet (attaches when they register)
  run(`INSERT INTO memberships (id, org_id, invited_phone, role, employment, status, invited_by) VALUES (?,?,?,?,?,?,?)`, [newId('mem'), U.kairaba, '+2207000099', 'attendant', 'employee', 'invited', U.ebrima]);

  /* ---- licences (Gambian groups: A private car, B motorcycle, C commercial, D special type) ---- */
  const licence = (key, number, classes, status = 'valid', expiresInDays = 400, extra = {}) =>
    run(`INSERT INTO licences (id, user_id, licence_number, classes, issued_at, expires_at, status, points, commercial_clearance_until, verified_by, verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId('lic'), U[key], number, JSON.stringify(classes), ago(900), ahead(expiresInDays), status, extra.points ?? 0, extra.clearance ?? null, status === 'pending' ? null : U.admin, status === 'pending' ? null : ago(890)]);
  licence('fatou', 'GM-DL-204518', ['A', 'B']);
  licence('lamin', 'GM-DL-318742', ['A']);          // a car licence only: cannot ride Fatou's motorbike
  licence('modou', 'GM-DL-100233', ['A', 'B']);
  licence('alieu', 'GM-DL-077615', ['A', 'C'], 'valid', 300, { points: 4 });
  licence('mariama', 'GM-DL-266190', ['A']);
  licence('samba', 'GM-DL-411057', ['A']);
  licence('ousman', 'GM-DL-150902', ['A', 'B']);

  /* ---- vehicles ---- */
  const vehicles = {};
  const vehicle = (key, o) => {
    const id = newId('veh');
    run(`INSERT INTO vehicles (id, vin, plate, plate_key, make, model, year, color, vehicle_class, fuel_type, severe_service, commercial_use, owner_user_id, odometer, odometer_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, o.vin, o.plate, plateKey(o.plate), o.make, o.model, o.year, o.color, o.cls, o.fuel, o.severe ? 1 : 0, o.commercial ? 1 : 0, U[o.owner], o.odo, new Date().toISOString()]);
    // Readings at a steady rate over 100 days so the engine can measure real usage
    for (let d = 100; d >= 0; d -= 10) run(`INSERT INTO odometer_readings (id, vehicle_id, value, source, recorded_by, recorded_at) VALUES (?,?,?,?,?,?)`, [newId('odo'), id, Math.round(o.odo - o.rate * d), 'owner', U[o.owner], ago(d)]);
    vehicles[key] = { id, ...o };
    appendBlock({ vehicleId: id, eventType: 'GENESIS', mileage: Math.round(o.odo - o.rate * 300), authority: 'system', timestamp: ago(300), actor: { id: U[o.owner], role: 'owner', name: 'Owner' }, description: 'Registered on Street Code. Self-declared.', payload: { vin: o.vin, plate: o.plate } });
    return id;
  };
  vehicle('rav4', { vin: 'JTMBF4DV5J5045412', plate: 'BJL-4821-B', make: 'Toyota', model: 'RAV4', year: 2018, color: 'Silver', cls: 'suv', fuel: 'petrol', owner: 'fatou', odo: 74200, rate: 38 });
  vehicle('bike', { vin: 'LWBPCJ9J6M1012345', plate: 'MC-BJL-0347-A', make: 'Honda', model: 'CG125', year: 2021, color: 'Red', cls: 'motorbike', fuel: 'petrol', owner: 'fatou', odo: 18650, rate: 32 });
  vehicle('hiace', { vin: 'JTFSX22P900012345', plate: 'WCR-1904-C', make: 'Toyota', model: 'Hiace', year: 2012, color: 'White', cls: 'minibus', fuel: 'diesel', owner: 'alieu', odo: 412800, rate: 150, severe: true, commercial: true });
  vehicle('corolla', { vin: '2T1BURHE0FC403215', plate: 'KM-7732-A', make: 'Toyota', model: 'Corolla', year: 2015, color: 'Blue', cls: 'car', fuel: 'petrol', owner: 'mariama', odo: 96300, rate: 30 });
  vehicle('tractor', { vin: 'MF3540-GM-00918', plate: 'BRK-0021-T', make: 'Massey Ferguson', model: 'MF 385', year: 2016, color: 'Red', cls: 'tractor', fuel: 'diesel', owner: 'modou', odo: 3180, rate: 4 });

  /* ---- service history: sealed by a verified garage where it matters ---- */
  const modou = loadUser(U.modou);
  // Service history is built oldest-first, with mileage that matches each vehicle's real usage rate.
  // (The passport refuses an odometer that goes backwards, which is the point.)
  const at_ = (key, days) => Math.round(vehicles[key].odo - vehicles[key].rate * days);
  const sealed = (key, code, days, product, garage = 'kairaba') => {
    const v = vehicles[key];
    const odo = at_(key, days);
    const gname = garage === 'kairaba' ? 'Kairaba Auto Works' : 'Brikama Motors and Tyres';
    const block = appendBlock({ vehicleId: v.id, eventType: 'ROUTINE_SERVICE', mileage: odo, authority: 'garage', timestamp: ago(days), actor: { id: U.modou, role: 'mechanic', name: modou.name, orgId: U[garage] }, description: `${code.replace('_', ' ')} (${gname})`, payload: { garage: gname, items: [{ item: code, product }], invoice: { total_minor: 45000 } } });
    addServiceRecord({ vehicleId: v.id, itemCode: code, performedAt: ago(days), odometer: odo, userId: U.modou, orgId: U[garage], product, passportBlockId: block.id, verified: true });
  };
  const self = (key, code, days, product = null) => addServiceRecord({ vehicleId: vehicles[key].id, itemCode: code, performedAt: ago(days), odometer: at_(key, days), userId: U[vehicles[key].owner], product, verified: false });

  // RAV4: oil comfortably fine, air filter creeping up, tyre rotation nearly due, freshly washed
  sealed('rav4', 'air_filter', 265);
  sealed('rav4', 'brake_inspection', 250);
  sealed('rav4', 'tyre_rotation', 162);
  sealed('rav4', 'engine_oil', 95, { oil_type: 'semi_synthetic', grade: '5W-30', brand: 'Total Quartz' });
  self('rav4', 'wash', 4);
  // Motorbike: mineral oil is well past its 2,500 km. Red.
  sealed('bike', 'engine_oil', 84, { oil_type: 'mineral', grade: '10W-40', brand: 'Castrol Active' }, 'brikama');
  self('bike', 'wash', 21);
  // Minibus: severe service, full synthetic, getting close
  sealed('hiace', 'engine_oil', 46, { oil_type: 'full_synthetic', grade: '5W-40', brand: 'Shell Helix' });
  self('hiace', 'wash', 9);
  // The stolen Corolla
  sealed('corolla', 'engine_oil', 70, { oil_type: 'semi_synthetic', grade: '5W-30', brand: 'Total Quartz' });
  // Tractor, by engine hours
  sealed('tractor', 'engine_oil', 52, { oil_type: 'mineral', grade: '15W-40', brand: 'Castrol CRB' }, 'brikama');

  /* ---- documents ---- */
  const doc = (key, kind, from, to, issuer) => run(`INSERT INTO vehicle_documents (id, vehicle_id, kind, number, issuer, valid_from, valid_to, status, verified_by, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [newId('doc'), vehicles[key].id, kind, `${kind.toUpperCase().slice(0, 3)}-${Math.floor(Math.random() * 90000 + 10000)}`, issuer, ago(from), ahead(to), 'verified', U.admin, U[vehicles[key].owner]]);
  for (const k of ['rav4', 'corolla', 'tractor']) { doc(k, 'registration', 300, 800, 'GPF Traffic Directorate'); doc(k, 'insurance', 165, 200, 'Gamstar'); doc(k, 'road_tax', 165, 200, 'Gambia Revenue Authority'); doc(k, 'roadworthiness', 100, 260, 'Vehicle Inspection Centre'); }
  doc('bike', 'registration', 300, 800, 'GPF Traffic Directorate'); doc('bike', 'insurance', 353, 12, 'Gamstar'); doc('bike', 'road_tax', 165, 200, 'Gambia Revenue Authority'); doc('bike', 'roadworthiness', 100, 260, 'Vehicle Inspection Centre');
  doc('hiace', 'registration', 300, 800, 'GPF Traffic Directorate'); doc('hiace', 'insurance', 374, -9, 'Gamstar'); doc('hiace', 'road_tax', 165, 200, 'Gambia Revenue Authority'); doc('hiace', 'roadworthiness', 90, 90, 'Vehicle Inspection Centre');

  /* ---- lending: Lamin drives Fatou's RAV4; he may also "use" the bike but his licence does not cover it ---- */
  const auth = (key, driver, kind, startD, endD, note) => { const id = newId('aut'); const u = one('SELECT phone, name FROM users WHERE id = ?', [U[driver]]); run(`INSERT INTO authorizations (id, vehicle_id, driver_user_id, driver_phone, driver_name, granted_by, kind, starts_at, ends_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, vehicles[key].id, U[driver], u.phone, u.name, U[vehicles[key].owner], kind, startD, endD, note]); return id; };
  const a1 = auth('rav4', 'lamin', 'friend', ago(1), ahead(2), 'Weekend trip to Kombo');
  auth('bike', 'lamin', 'friend', ago(1), ahead(2), 'Errands');
  run(`INSERT INTO drive_sessions (id, vehicle_id, driver_user_id, authorization_id, basis, started_at, start_odometer) VALUES (?,?,?,?,?,?,?)`, [newId('drv'), vehicles.rav4.id, U.lamin, a1, 'authorization', ago(0.1), vehicles.rav4.odo]);
  run(`INSERT INTO drive_sessions (id, vehicle_id, driver_user_id, basis, started_at, start_odometer) VALUES (?,?,?,?,?,?)`, [newId('drv'), vehicles.hiace.id, U.alieu, 'owner', ago(0.2), vehicles.hiace.odo]);

  /* ---- jobs ---- */
  const job = (o) => { const id = newId('job'); run(`INSERT INTO jobs (id, org_id, vehicle_id, customer_id, mechanic_id, opened_by, status, owner_consent, complaint, labour_minor, parts_minor, total_minor, odometer_in) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, U[o.org], vehicles[o.veh].id, U[o.customer], o.mech ? U[o.mech] : null, U[o.by], o.status, o.consent, o.complaint, o.labour ?? 0, o.parts ?? 0, (o.labour ?? 0) + (o.parts ?? 0), vehicles[o.veh].odo]); return id; };
  job({ org: 'kairaba', veh: 'rav4', customer: 'fatou', mech: 'modou', by: 'fatou', status: 'accepted', consent: 1, complaint: 'Squeal from the front brakes when stopping', labour: 60000, parts: 185000 });
  job({ org: 'brikama', veh: 'bike', customer: 'fatou', by: 'modou', status: 'requested', consent: 0, complaint: 'Oil change and chain adjustment' });

  /* ---- parts ---- */
  for (const [n, c, pn, fits, price, stock, sup, oem] of [
    ['Front brake pads (set)', 'Brakes', '04465-42160', 'Toyota RAV4 2013-2018', 18500000 / 100, 6, 'Kairaba Parts', 1],
    ['Oil filter', 'Filters', '90915-YZZD4', 'Toyota Corolla, RAV4, Hiace', 3500, 40, 'Brikama Spares', 1],
    ['Engine oil 5W-30 semi-synthetic (4 L)', 'Fluids', 'TQ-5W30-4L', 'Most petrol cars', 9800, 25, 'Total Gambia', 0],
    ['Motorbike chain and sprocket kit', 'Drivetrain', 'CG125-CSK', 'Honda CG125', 14500, 8, 'Brikama Spares', 0],
    ['Air filter element', 'Filters', '17801-0V020', 'Toyota RAV4 2013-2018', 4800, 12, 'Kairaba Parts', 1],
  ]) run('INSERT INTO parts (id, name, category, part_number, fits, price_minor, stock, supplier, is_oem) VALUES (?,?,?,?,?,?,?,?,?)', [newId('prt'), n, c, pn, fits, Math.round(price * 100), stock, sup, oem]);

  /* ---- a citation each way ---- */
  const cit = (key, driver, code, title, fine, waivable, n) => run(`INSERT INTO citations (id, number, vehicle_id, driver_id, officer_id, code, title, fine_minor, waivable) VALUES (?,?,?,?,?,?,?,?,?)`, [newId('cit'), `GM-${new Date().getUTCFullYear()}-${n}`, vehicles[key].id, driver ? U[driver] : null, U.ousman, code, title, fine, waivable]);
  cit('hiace', 'alieu', 'EXP_INSURANCE', 'No valid insurance', 200000, 0, '000101');
  cit('rav4', 'lamin', 'SPEEDING', 'Speeding', 100000, 1, '000102');

  /* ---- police: the stolen Corolla, a person of interest, and a request waiting for a supervisor ---- */
  const ousman = loadUser(U.ousman); const isatou = loadUser(U.isatou);
  const stolen = createFlag({ user: ousman, subjectType: 'vehicle', subjectId: vehicles.corolla.id, kind: 'stolen', summary: 'Stolen from outside Westfield, Serrekunda', detail: 'Owner left the vehicle 20:40. Keys were in it.', caseRef: 'SKD/2026/0912', instruction: 'call_dispatch' });
  createFlag({ user: ousman, subjectType: 'person', subjectId: U.samba, kind: 'person_of_interest', summary: 'Wanted for questioning about vehicle theft', detail: 'Seen with the stolen Corolla near Westfield. Do not confront. Report location only.', caseRef: 'SKD/2026/0912', instruction: 'observe' });
  // The person flag needs a second person: only now is it active
  const poi = one(`SELECT id FROM flags WHERE subject_type = 'person' AND status = 'reported'`);
  approveFlag({ user: isatou, id: poi.id });
  createFlag({ user: ousman, subjectType: 'person', subjectId: U.lamin, kind: 'wanted', summary: 'Placeholder to demonstrate the approval queue', detail: 'Demo flag awaiting supervisor approval. Delete before real use.', instruction: 'call_dispatch' });
  for (const [i, [lat, lng]] of [[13.4383, -16.6781], [13.4401, -16.6720], [13.4425, -16.6650], [13.4409, -16.6702]].entries()) run(`INSERT INTO telemetry (id, vehicle_id, source, speed_kph, lat, lng, ts) VALUES (?,?,?,?,?,?,?)`, [newId('tel'), vehicles.corolla.id, 'phone', 30 + i * 4, lat, lng, new Date(Date.now() - (5 - i) * 600000).toISOString()]);

  /* ---- real checks, so the audit trail has substance ---- */
  const at = { label: 'Kairaba Avenue checkpoint', lat: 13.4392, lng: -16.6785 };
  verifyVehicle({ user: ousman, query: 'BJL 4821 B', reason: 'Routine checkpoint', location: at });
  verifyVehicle({ user: ousman, query: 'WCR-1904-C', reason: 'Expired documents', location: at });
  verifyVehicle({ user: ousman, query: 'KM-7732-A', reason: 'Active alert or APB', location: { label: 'Bakau roundabout', lat: 13.4787, lng: -16.6817 } });

  audit({ action: 'seed.complete', details: { users: Object.keys(U).length } });
  const alerts = runAlerts();
  log(`Seeded ${Object.keys(vehicles).length} vehicles, alerts: ${JSON.stringify(alerts)}`);
  return { users: U, vehicles };
}
