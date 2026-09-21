import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const oil = (health) => health.items.find((i) => i.code === 'engine_oil');

/* ------------------------- the service-due engine ------------------------- */

test('each vehicle shows a different point on the green-to-red scale, from real seeded history', async () => {
  const fatou = await t.as('fatou'); const alieu = await t.as('alieu'); const modou = await t.as('modou');
  const rav4 = await t.api('GET', `/api/vehicles/${t.vehicleId('BJL-4821-B')}`, { token: fatou });
  const o = oil(rav4.body.health);
  assert.equal(o.status, 'good');
  assert.equal(o.product.oil_type, 'semi_synthetic');
  assert.equal(o.intervalDistance, 7500);
  assert.equal(o.finishLine.odometer, 70590 + 7500, 'due odometer = odometer at service + interval');
  assert.ok(o.finishLine.date, 'a due date is projected');
  assert.equal(o.verified, true, 'sealed by a garage');
  assert.equal(rav4.body.health.usage.confidence, 'measured');
  assert.ok(Math.abs(rav4.body.health.usage.perDay - 38) < 1, 'learned usage is close to the true 38 km/day');

  const bike = await t.api('GET', `/api/vehicles/${t.vehicleId('MC-BJL-0347-A')}`, { token: fatou });
  assert.equal(oil(bike.body.health).intervalDistance, 2500, 'motorbike mineral oil is shorter');
  assert.ok(['overdue', 'critical'].includes(oil(bike.body.health).status), 'the bike is past its oil interval');
  assert.ok(oil(bike.body.health).overdueDistance > 0);

  const bus = await t.api('GET', `/api/vehicles/${t.vehicleId('WCR-1904-C')}`, { token: alieu });
  assert.equal(oil(bus.body.health).intervalDistance, 7500, 'severe service (taxi/minibus) cuts full synthetic from 10,000 to 7,500');
  assert.equal(oil(bus.body.health).status, 'soon');

  const tractor = await t.api('GET', `/api/vehicles/${t.vehicleId('BRK-0021-T')}`, { token: modou });
  assert.equal(tractor.body.health.unit, 'hours');
  assert.equal(oil(tractor.body.health).intervalDistance, 250);
  assert.ok(!tractor.body.health.items.some((i) => i.code === 'tyre_rotation'), 'no tyre rotation for a tractor');
});

test('the garage list shows the most urgent item per vehicle, worst status overall', async () => {
  const r = await t.api('GET', '/api/vehicles', { token: await t.as('fatou') });
  const byPlate = Object.fromEntries(r.body.vehicles.map((v) => [v.plate, v]));
  assert.equal(Object.keys(byPlate).length, 2);
  assert.ok(['overdue', 'critical'].includes(byPlate['MC-BJL-0347-A'].health.overall));
  assert.ok(['good', 'watch', 'soon'].includes(byPlate['BJL-4821-B'].health.overall));
  assert.equal(byPlate['BJL-4821-B'].health.next.pct >= byPlate['BJL-4821-B'].health.items[1].pct, true, 'sorted most urgent first');
});

test('car wash is tracked on a 14-day clock, and logging one resets the bar', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('MC-BJL-0347-A');
  const before = (await t.api('GET', `/api/vehicles/${id}/health`, { token: fatou })).body.health.items.find((i) => i.code === 'wash');
  assert.equal(before.intervalDays, 14);
  assert.ok(before.status === 'overdue' || before.status === 'critical', 'washed 21 days ago');
  const log = await t.api('POST', `/api/vehicles/${id}/services`, { token: fatou, body: { item_code: 'wash' } });
  assert.equal(log.status, 201);
  const after = log.body.health.items.find((i) => i.code === 'wash');
  assert.equal(after.status, 'good');
  assert.equal(after.verified, false, 'self-logged work is never shown as garage-verified');
});

test('logging your own oil change with the oil type restarts that bar, and validates input', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('MC-BJL-0347-A');
  assert.equal((await t.api('POST', `/api/vehicles/${id}/services`, { token: fatou, body: { item_code: 'engine_oil' } })).status, 400, 'oil needs a type');
  const ok = await t.api('POST', `/api/vehicles/${id}/services`, { token: fatou, body: { item_code: 'engine_oil', oil_type: 'full_synthetic', oil_grade: '10W-40', odometer: 18700 } });
  assert.equal(ok.status, 201);
  const o = oil(ok.body.health);
  assert.equal(o.status, 'good');
  assert.equal(o.intervalDistance, 6000, 'bike full synthetic');
  assert.equal(o.finishLine.odometer, 18700 + 6000);
  const tractor = t.vehicleId('BRK-0021-T');
  assert.equal((await t.api('POST', `/api/vehicles/${tractor}/services`, { token: await t.as('modou'), body: { item_code: 'tyre_rotation' } })).status, 400);
  assert.equal((await t.api('POST', `/api/vehicles/${id}/services`, { token: fatou, body: { item_code: 'wash', performed_at: '2099-01-01' } })).status, 400, 'no future dates');
});

test('someone with driving rights cannot rewrite the owner’s service history', async () => {
  const r = await t.api('POST', `/api/vehicles/${t.vehicleId('BJL-4821-B')}/services`, { token: await t.as('lamin'), body: { item_code: 'wash' } });
  assert.equal(r.status, 403);
});

test('per-vehicle interval override changes the finish line', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('BJL-4821-B');
  const r = await t.api('PUT', `/api/vehicles/${id}/settings/tyre_rotation`, { token: fatou, body: { interval_distance: 5000 } });
  assert.equal(r.body.health.items.find((i) => i.code === 'tyre_rotation').intervalDistance, 5000);
});

/* ------------------------------ odometer ------------------------------ */

test('odometer: a lower reading is refused as a rollback, recorded, and the owner is told', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('BJL-4821-B');
  const r = await t.api('POST', `/api/vehicles/${id}/odometer`, { token: fatou, body: { value: 60000 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'rollback');
  assert.equal(t.db.one(`SELECT COUNT(*) AS n FROM odometer_readings WHERE vehicle_id = ? AND status = 'anomaly'`, [id]).n, 1);
  assert.equal(t.db.one('SELECT odometer FROM vehicles WHERE id = ?', [id]).odometer, 74200, 'the real odometer did not move');
  assert.ok(t.db.one(`SELECT id FROM notifications WHERE kind = 'odometer' AND vehicle_id = ?`, [id]));
  assert.ok(t.db.one(`SELECT id FROM audit_logs WHERE action = 'odometer.rollback'`));
});

test('odometer: an impossible jump is refused; a normal reading is accepted and updates usage', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', `/api/vehicles/${id}/odometer`, { token: fatou, body: { value: 174200 } })).status, 422, 'an extra digit typo');
  const ok = await t.api('POST', `/api/vehicles/${id}/odometer`, { token: fatou, body: { value: 74260 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.vehicle.odometer, 74260);
  assert.equal((await t.api('POST', `/api/vehicles/${id}/odometer`, { token: fatou, body: { value: 'abc' } })).status, 400);
});

test('odometer: a stranger cannot log readings on your car', async () => {
  assert.equal((await t.api('POST', `/api/vehicles/${t.vehicleId('BJL-4821-B')}/odometer`, { token: await t.as('samba'), body: { value: 80000 } })).status, 403);
});

/* -------------------------------- alerts -------------------------------- */

test('alerts: overdue and expiring things become notifications, exactly once', async () => {
  const { runAlerts } = await import(new URL('../src/services/scheduler.js', import.meta.url));
  runAlerts(); // anything newly due since the seed
  const second = runAlerts();
  assert.equal(second.service, 0); assert.equal(second.documents, 0, 'nothing is sent twice');
  const fatou = await t.api('GET', '/api/me/notifications', { token: await t.as('fatou') });
  const titles = fatou.body.notifications.map((n) => n.title).join(' | ');
  assert.match(titles, /Oil|oil/, 'the overdue bike oil');
  assert.match(titles, /insurance expires in/i, 'the bike insurance is 12 days from expiry');
  const alieu = await t.api('GET', '/api/me/notifications', { token: await t.as('alieu') });
  assert.match(alieu.body.notifications.map((n) => n.title).join(' | '), /insurance has expired/i);
  assert.ok(alieu.body.unread > 0);
  await t.api('POST', '/api/me/notifications/read', { token: await t.as('alieu'), body: {} });
  assert.equal((await t.api('GET', '/api/me/notifications', { token: await t.as('alieu') })).body.unread, 0);
});

/* ----------------------- lending a car / driving ------------------------ */

test('lending: validation', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('BJL-4821-B');
  const lend = (body) => t.api('POST', `/api/vehicles/${id}/authorizations`, { token: fatou, body });
  assert.equal((await lend({ phone: '+2207000001', kind: 'friend' })).status, 400, 'not to yourself');
  assert.equal((await lend({ phone: '+2207000010', kind: 'rental' })).status, 400, 'a rental needs an end');
  assert.equal((await lend({ phone: '+2207000010', kind: 'friend', starts_at: '2030-01-02T00:00:00Z', ends_at: '2030-01-01T00:00:00Z' })).status, 400, 'end before start');
  assert.equal((await lend({ phone: '+2207000010', kind: 'stranger' })).status, 400);
  assert.equal((await t.api('POST', `/api/vehicles/${id}/authorizations`, { token: await t.as('lamin'), body: { phone: '+2207000010', kind: 'friend' } })).status, 403, 'a borrower cannot re-lend');
});

test('lending to someone with no account: it attaches when they register', async () => {
  const fatou = await t.as('fatou'); const id = t.vehicleId('BJL-4821-B');
  const r = await t.api('POST', `/api/vehicles/${id}/authorizations`, { token: fatou, body: { phone: '2207123456', name: 'Dad', kind: 'family', note: 'Dad borrows it' } });
  assert.equal(r.status, 201); assert.equal(r.body.driverHasAccount, false);
  assert.equal(r.body.authorization.driver_user_id, null);
  const reg = await t.api('POST', '/api/auth/register', { body: { name: 'Dad Jallow', phone: '+2207123456', password: 'longenough1' } });
  const mine = await t.api('GET', '/api/me/authorizations', { token: reg.body.token });
  assert.equal(mine.body.authorizations.length, 1);
  assert.equal(mine.body.authorizations[0].plate, 'BJL-4821-B');
});

test('driving: a licence that does not cover the vehicle cannot start a drive (Lamin holds group A only)', async () => {
  const lamin = await t.as('lamin');
  const r = await t.api('POST', '/api/drive/start', { token: lamin, body: { vehicle_id: t.vehicleId('MC-BJL-0347-A') } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /group B|Motorcycle/);
});

test('driving: no permission, no drive. Permission works, and only one driver at a time', async () => {
  const samba = await t.as('samba'); const lamin = await t.as('lamin'); const fatou = await t.as('fatou');
  const rav = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', '/api/drive/start', { token: samba, body: { vehicle_id: rav } })).status, 403);
  const again = await t.api('POST', '/api/drive/start', { token: lamin, body: { vehicle_id: rav } });
  assert.equal(again.status, 200, 'he already has a session; starting again returns it');
  assert.equal(again.body.session.vehicle.plate, 'BJL-4821-B');
  assert.equal((await t.api('POST', '/api/drive/start', { token: fatou, body: { vehicle_id: rav } })).status, 409, 'someone else is driving it');
  await t.api('POST', `/api/vehicles/${rav}/drive/end`, { token: fatou });
  assert.equal((await t.api('GET', '/api/drive/current', { token: lamin })).body.session, null, 'the owner can always take the car back');
});

test('revoking permission ends the journey immediately', async () => {
  const fatou = await t.as('fatou'); const lamin = await t.as('lamin'); const rav = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', '/api/drive/start', { token: lamin, body: { vehicle_id: rav } })).status, 201);
  const auth = t.db.one(`SELECT id FROM authorizations WHERE vehicle_id = ? AND driver_user_id = (SELECT id FROM users WHERE phone = '+2207000002') AND status = 'active'`, [rav]);
  assert.equal((await t.api('POST', `/api/authorizations/${auth.id}/revoke`, { token: fatou })).status, 200);
  assert.equal((await t.api('GET', '/api/drive/current', { token: lamin })).body.session, null);
  assert.equal((await t.api('POST', '/api/drive/start', { token: lamin, body: { vehicle_id: rav } })).status, 403);
  assert.ok(t.db.one(`SELECT id FROM notifications WHERE user_id = (SELECT id FROM users WHERE phone = '+2207000002') AND title LIKE '%withdrawn%'`));
});

test('a stolen vehicle: the owner is told plainly; anyone else gets a bland refusal and police get a silent sighting', async () => {
  const corolla = t.vehicleId('KM-7732-A');
  const owner = await t.api('POST', '/api/drive/start', { token: await t.as('mariama'), body: { vehicle_id: corolla } });
  assert.equal(owner.status, 409); assert.match(owner.body.error, /police stolen list/);
  const thief = await t.api('POST', '/api/drive/start', { token: await t.as('samba'), body: { vehicle_id: corolla, lat: 13.44, lng: -16.68 } });
  assert.equal(thief.status, 409);
  assert.doesNotMatch(thief.body.error, /police|stolen|alert/i, 'no hint that anyone was told');
  const sightings = t.db.all(`SELECT source FROM sightings WHERE vehicle_id = ? AND source = 'drive_session'`, [corolla]);
  assert.equal(sightings.length, 2);
});

/* ------------------------------- transfer ------------------------------- */

test('transfer: a vehicle with a police flag cannot be sold', async () => {
  const r = await t.api('POST', `/api/vehicles/${t.vehicleId('KM-7732-A')}/transfer`, { token: await t.as('mariama'), body: { to_phone: '+2207000010' } });
  assert.equal(r.status, 409);
});

test('transfer: seller offers, buyer accepts; lending ends, history stays intact, public view hides names', async () => {
  const fatou = await t.as('fatou'); const samba = await t.as('samba'); const rav = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', `/api/vehicles/${rav}/transfer`, { token: samba, body: { to_phone: '+2207000010' } })).status, 403, 'only the owner can sell');
  const offer = await t.api('POST', `/api/vehicles/${rav}/transfer`, { token: fatou, body: { to_phone: '+2207000010', price_gmd: 450000 } });
  assert.equal(offer.status, 201);
  const incoming = await t.api('GET', '/api/me/transfers', { token: samba });
  assert.equal(incoming.body.incoming.length, 1);
  assert.equal((await t.api('POST', `/api/transfers/${offer.body.transfer.id}/accept`, { token: fatou })).status, 403, 'the seller cannot accept for the buyer');
  assert.equal((await t.api('POST', `/api/transfers/${offer.body.transfer.id}/accept`, { token: samba })).status, 200);
  assert.equal(t.db.one('SELECT owner_user_id FROM vehicles WHERE id = ?', [rav]).owner_user_id, t.db.one(`SELECT id FROM users WHERE phone = '+2207000010'`).id);
  assert.equal(t.db.one(`SELECT COUNT(*) AS n FROM authorizations WHERE vehicle_id = ? AND status = 'active'`, [rav]).n, 0, 'the old owner’s lending is gone');
  const pass = await t.api('GET', `/api/vehicles/${rav}/passport`, { token: samba });
  assert.equal(pass.body.verification.valid, true);
  assert.ok(pass.body.blocks.some((b) => b.event_type === 'OWNERSHIP_TRANSFER'));
  const pub = JSON.stringify((await t.api('GET', '/api/public/vehicle?q=BJL4821B')).body);
  assert.ok(!pub.includes('Fatou') && !pub.includes('Samba'), 'names never appear publicly');
  assert.equal((await t.api('GET', `/api/vehicles/${rav}`, { token: fatou })).status, 403, 'the old owner has no access any more');
});

/* ------------------------------ registration ---------------------------- */

test('registering a vehicle: plate and VIN are unique, plates are normalised, classes drive the units', async () => {
  const tok = await t.as('ebrima');
  const body = { vin: 'ABC123456789XYZ01', plate: 'ser 4455 a', make: 'Toyota', model: 'Hilux', year: 2014, vehicle_class: 'pickup', odometer: 150000, commercial_use: true };
  const ok = await t.api('POST', '/api/vehicles', { token: tok, body });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.vehicle.plate, 'SER 4455 A');
  assert.equal(ok.body.vehicle.commercial_use, true);
  assert.equal((await t.api('POST', '/api/vehicles', { token: tok, body: { ...body, vin: 'ZZZ999888777XYZ01' } })).status, 409, 'same plate, different spacing');
  assert.equal((await t.api('POST', '/api/vehicles', { token: tok, body: { ...body, plate: 'OTHER-1' } })).status, 409, 'same VIN');
  assert.equal((await t.api('POST', '/api/vehicles', { token: tok, body: { ...body, plate: 'X-2', vin: 'QQQQQQQQQQ11', year: 1800 } })).status, 400);
  const pass = await t.api('GET', `/api/vehicles/${ok.body.vehicle.id}/passport`, { token: tok });
  assert.equal(pass.body.verification.valid, true); assert.equal(pass.body.blocks[0].event_type, 'GENESIS');
});
