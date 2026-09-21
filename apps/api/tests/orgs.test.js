import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const kairaba = () => t.db.one(`SELECT id FROM orgs WHERE name = 'Kairaba Auto Works'`).id;
const brikama = () => t.db.one(`SELECT id FROM orgs WHERE name LIKE 'Brikama%'`).id;
const memberOf = (org, phone) => t.db.one(`SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.phone = ? AND m.status != 'ended'`, [org, phone]);

test('one person, two garages: Modou is an employee at one and the owner of another', async () => {
  const r = await t.api('GET', '/api/orgs/mine', { token: await t.as('modou') });
  const by = Object.fromEntries(r.body.orgs.map((o) => [o.name, o]));
  assert.equal(by['Kairaba Auto Works'].role, 'mechanic'); assert.equal(by['Kairaba Auto Works'].employment, 'employee');
  assert.equal(by['Brikama Motors and Tyres'].role, 'owner'); assert.equal(by['Brikama Motors and Tyres'].employment, 'owner');
  const me = await t.api('GET', '/api/auth/me', { token: await t.as('modou') });
  assert.equal(me.body.user.capabilities.garage, true); assert.equal(me.body.user.capabilities.police, false);
});

test('the boss can add staff below his rank, and cannot add an owner', async () => {
  const ebrima = await t.as('ebrima'); const k = kairaba();
  const ok = await t.api('POST', `/api/orgs/${k}/members`, { token: ebrima, body: { phone: '+2207000888', role: 'mechanic', employment: 'contractor' } });
  assert.equal(ok.status, 201); assert.equal(ok.body.hasAccount, false, 'invited by phone before they have an account');
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: ebrima, body: { phone: '+2207000889', role: 'owner' } })).status, 403);
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: ebrima, body: { phone: '+2207000888', role: 'mechanic' } })).status, 409, 'already invited');
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: ebrima, body: { phone: '+2207000889', role: 'driver' } })).status, 400, 'no such role in a garage');
});

test('a mechanic cannot manage staff; a manager can, but only below himself, and never himself or the owner', async () => {
  const ebrima = await t.as('ebrima'); const modou = await t.as('modou'); const k = kairaba();
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: modou, body: { phone: '+2207000777', role: 'attendant' } })).status, 403, 'a mechanic');
  const mm = memberOf(k, '+2207000004').id;
  assert.equal((await t.api('PATCH', `/api/memberships/${mm}`, { token: ebrima, body: { role: 'manager' } })).status, 200, 'the boss promotes him');
  const me = await t.api('POST', '/api/auth/login', { body: { phone: '+2207000004', password: 'streetcode' } });
  const modouAsManager = me.body.token;
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: modouAsManager, body: { phone: '+2207000777', role: 'manager' } })).status, 403, 'a manager cannot appoint a manager');
  assert.equal((await t.api('POST', `/api/orgs/${k}/members`, { token: modouAsManager, body: { phone: '+2207000777', role: 'attendant' } })).status, 201);
  assert.equal((await t.api('PATCH', `/api/memberships/${memberOf(k, '+2207000003').id}`, { token: modouAsManager, body: { status: 'suspended' } })).status, 403, 'nobody manages the owner');
  assert.equal((await t.api('PATCH', `/api/memberships/${mm}`, { token: modouAsManager, body: { role: 'owner' } })).status, 403, 'nor promotes themselves');
  const staff = await t.api('GET', `/api/orgs/${k}/members`, { token: modouAsManager });
  assert.equal(staff.body.canManage, true); assert.ok(staff.body.members.every((m) => m.user_phone !== undefined || m.status === 'invited'));
});

test('suspending a member takes effect at once; the last owner cannot walk away', async () => {
  const ebrima = await t.as('ebrima'); const k = kairaba();
  const jobsUrl = `/api/orgs/${k}/jobs`;
  const modou = await t.as('modou');
  assert.equal((await t.api('GET', jobsUrl, { token: modou })).status, 200);
  const mm = memberOf(k, '+2207000004').id;
  await t.api('PATCH', `/api/memberships/${mm}`, { token: ebrima, body: { status: 'suspended' } });
  assert.equal((await t.api('GET', jobsUrl, { token: modou })).status, 403, 'the same token stops working for this garage immediately');
  await t.api('PATCH', `/api/memberships/${mm}`, { token: ebrima, body: { status: 'active' } });
  assert.equal((await t.api('GET', jobsUrl, { token: modou })).status, 200);
  assert.equal((await t.api('DELETE', `/api/memberships/${memberOf(k, '+2207000003').id}`, { token: ebrima })).status, 409, 'the only owner');
});

test('an invitation attaches to the phone number when the person registers, and they accept it', async () => {
  await t.api('POST', '/api/auth/register', { body: { name: 'New Attendant', phone: '+2207000099', password: 'longenough1' } });
  const tok = (await t.api('POST', '/api/auth/login', { body: { phone: '+2207000099', password: 'longenough1' } })).body.token;
  const inv = await t.api('GET', '/api/me/invitations', { token: tok });
  assert.equal(inv.body.invitations.length, 1); assert.equal(inv.body.invitations[0].org_name, 'Kairaba Auto Works');
  assert.equal((await t.api('GET', '/api/auth/me', { token: tok })).body.user.memberships.length, 0, 'invited is not a member yet');
  assert.equal((await t.api('POST', `/api/memberships/${inv.body.invitations[0].id}/respond`, { token: tok, body: { accept: true } })).status, 200);
  const me = await t.api('GET', '/api/auth/me', { token: tok });
  assert.equal(me.body.user.memberships[0].role, 'attendant');
  const list = await t.api('GET', `/api/orgs/${kairaba()}/members`, { token: tok });
  assert.equal(list.body.canManage, false); assert.ok(list.body.members.every((m) => m.user_phone === undefined), 'an attendant does not see colleagues’ phone numbers');
});

test('a new garage is pending until an administrator verifies it, and cannot take jobs meanwhile', async () => {
  const fatou = await t.as('fatou');
  const org = await t.api('POST', '/api/orgs', { token: fatou, body: { type: 'garage', name: 'Fatou Auto Care', location: 'Bakau', bays: 2 } });
  assert.equal(org.status, 201); assert.equal(org.body.org.status, 'pending');
  const bike = t.vehicleId('MC-BJL-0347-A');
  assert.equal((await t.api('POST', `/api/orgs/${org.body.org.id}/jobs`, { token: await t.as('lamin'), body: { plate: 'BJL-4821-B', complaint: 'Check the brakes' } })).status, 400);
  assert.equal((await t.api('POST', `/api/admin/orgs/${org.body.org.id}/verify`, { token: fatou, body: { approve: true } })).status, 403, 'you cannot verify yourself');
  await t.api('POST', `/api/admin/orgs/${org.body.org.id}/verify`, { token: await t.as('admin'), body: { approve: true } });
  assert.equal((await t.api('GET', '/api/public/garages')).body.garages.some((g) => g.name === 'Fatou Auto Care'), true);
});

/* -------------------------------- jobs -------------------------------- */

const seededJob = () => t.db.one(`SELECT * FROM jobs WHERE status = 'accepted'`);

test('only staff of the garage that owns the job can complete it', async () => {
  const j = seededJob();
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/complete`, { token: await t.as('fatou'), body: { odometer: 74300, summary: 'Brake pads replaced' } })).status, 403, 'the customer');
  // A mechanic at a different garage
  await t.api('POST', '/api/auth/register', { body: { name: 'Other Mechanic', phone: '+2207000666', password: 'longenough1' } });
  await t.api('POST', `/api/orgs/${brikama()}/members`, { token: await t.as('modou'), body: { phone: '+2207000666', role: 'mechanic' } });
  const other = (await t.api('POST', '/api/auth/login', { body: { phone: '+2207000666', password: 'longenough1' } })).body.token;
  const inv = await t.api('GET', '/api/me/invitations', { token: other });
  await t.api('POST', `/api/memberships/${inv.body.invitations[0].id}/respond`, { token: other, body: { accept: true } });
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/complete`, { token: other, body: { odometer: 74300, summary: 'Brake pads replaced' } })).status, 403, 'a mechanic at Brikama cannot seal Kairaba’s job');
  assert.equal((await t.api('PATCH', `/api/jobs/${j.id}`, { token: other, body: { status: 'ready' } })).status, 403);
});

test('completing a job: a rolled-back odometer is refused AND the attempt is still on record', async () => {
  const j = seededJob(); const v = t.db.one('SELECT id, plate FROM vehicles WHERE id = ?', [j.vehicle_id]);
  const before = t.db.one('SELECT COUNT(*) AS n FROM passport_blocks WHERE vehicle_id = ?', [v.id]).n;
  const r = await t.api('POST', `/api/jobs/${j.id}/complete`, { token: await t.as('modou'), body: { odometer: 50000, summary: 'Brake pads replaced' } });
  assert.equal(r.status, 409);
  assert.equal(t.db.one('SELECT COUNT(*) AS n FROM passport_blocks WHERE vehicle_id = ?', [v.id]).n, before, 'nothing was sealed');
  assert.equal(t.db.one(`SELECT COUNT(*) AS n FROM odometer_readings WHERE vehicle_id = ? AND status = 'anomaly'`, [v.id]).n, 1, 'the attempt survived the refusal');
  assert.ok(t.db.one(`SELECT id FROM audit_logs WHERE action = 'odometer.rollback'`));
});

test('completing a job seals verified records into the passport and restarts the oil bar from the garage’s odometer', async () => {
  const j = seededJob(); const modou = await t.as('modou');
  const bad = await t.api('POST', `/api/jobs/${j.id}/complete`, { token: modou, body: { odometer: 74300, summary: 'Oil change', items: [{ item_code: 'engine_oil' }] } });
  assert.equal(bad.status, 400, 'an oil change must say which oil');
  const ok = await t.api('POST', `/api/jobs/${j.id}/complete`, { token: modou, body: {
    odometer: 74300, summary: 'Front brake pads replaced, oil and filter changed',
    items: [{ item_code: 'brake_inspection' }, { item_code: 'engine_oil', oil_type: 'full_synthetic', oil_grade: '5W-30', brand: 'Mobil 1' }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.job.status, 'completed');
  const oil = ok.body.health.items.find((i) => i.code === 'engine_oil');
  assert.equal(oil.product.oil_type, 'full_synthetic'); assert.equal(oil.intervalDistance, 10000);
  assert.equal(oil.finishLine.odometer, 84300); assert.equal(oil.verified, true); assert.ok(oil.pct < 0.05);
  const fatou = await t.as('fatou');
  const pass = await t.api('GET', `/api/vehicles/${j.vehicle_id}/passport`, { token: fatou });
  assert.equal(pass.body.verification.valid, true);
  const blk = pass.body.blocks.at(-1);
  assert.equal(blk.actor_role, 'mechanic'); assert.equal(blk.actor_name, 'Modou Bah'); assert.equal(blk.payload.garage, 'Kairaba Auto Works');
  assert.equal(blk.payload.invoice.total_minor, j.total_minor, 'the invoice is inside the signed block');
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/complete`, { token: modou, body: { odometer: 74400, summary: 'Again' } })).status, 409, 'cannot complete twice');
  assert.match((await t.api('GET', '/api/me/notifications', { token: fatou })).body.notifications.map((n) => n.title).join('|'), /Work on BJL-4821-B is complete/);
  const pub = (await t.api('GET', '/api/public/vehicle?q=BJL-4821-B')).body;
  assert.equal(pub.history[0].verified, true); assert.equal(pub.history[0].by, 'Kairaba Auto Works');
});

test('a garage cannot touch a car until its owner approves the job; the owner can refuse', async () => {
  const j = t.db.one(`SELECT * FROM jobs WHERE status = 'requested' AND owner_consent = 0`);
  const modou = await t.as('modou'); const fatou = await t.as('fatou');
  assert.equal((await t.api('PATCH', `/api/jobs/${j.id}`, { token: modou, body: { labour_gmd: 200, status: 'quoted' } })).status, 409, 'no consent yet');
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/consent`, { token: await t.as('lamin'), body: { approve: true } })).status, 403, 'only the owner can approve');
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/consent`, { token: fatou, body: { approve: true } })).status, 200);
  assert.equal((await t.api('PATCH', `/api/jobs/${j.id}`, { token: modou, body: { status: 'quoted' } })).status, 400, 'a quote needs a price');
  const q = await t.api('PATCH', `/api/jobs/${j.id}`, { token: modou, body: { labour_gmd: 200, parts_gmd: 145.5, status: 'quoted' } });
  assert.equal(q.body.job.total_minor, 34550);
  assert.equal((await t.api('PATCH', `/api/jobs/${j.id}`, { token: modou, body: { status: 'in_progress' } })).status, 409, 'cannot skip the customer accepting the quote');
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/accept`, { token: modou })).status, 403, 'the garage cannot accept its own quote');
  assert.equal((await t.api('POST', `/api/jobs/${j.id}/accept`, { token: fatou })).status, 200);
  assert.equal((await t.api('PATCH', `/api/jobs/${j.id}`, { token: modou, body: { status: 'in_progress' } })).body.job.status, 'in_progress');
  const done = await t.api('POST', `/api/jobs/${j.id}/complete`, { token: modou, body: { odometer: 18800, summary: 'Chain adjusted, oil changed', items: [{ item_code: 'engine_oil', oil_type: 'mineral' }] } });
  assert.equal(done.status, 200);
  assert.equal(done.body.health.items.find((i) => i.code === 'engine_oil').intervalDistance, 2500);
  const refuse = await t.api('POST', '/api/orgs/' + brikama() + '/jobs', { token: modou, body: { plate: 'BJL-4821-B', complaint: 'Unrequested work' } });
  assert.equal(refuse.status, 201, 'staff can open it on the owner’s behalf');
  assert.equal((await t.api('POST', `/api/jobs/${refuse.body.job.id}/consent`, { token: fatou, body: { approve: false } })).body.job.status, 'cancelled');
});
