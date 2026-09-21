import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, AT } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const check = async (who, query, extra = {}) => t.api('POST', '/api/police/check', { token: await t.as(who), body: { query, reason: 'Routine checkpoint', ...AT, ...extra } });
const state = (r, id) => r.body.verdict.checks.find((c) => c.id === id)?.state;
const nChecks = () => t.db.one('SELECT COUNT(*) AS n FROM police_checks').n;

/* -------- the roadside check: a plate is enough -------- */

test('an authorised friend driving a clean car: the officer sees who, on whose authority, and that the licence covers it', async () => {
  const r = await check('ousman', 'bjl 4821 b'); // sloppy input still matches
  assert.equal(r.status, 200);
  assert.equal(r.body.driver.name, 'Lamin Ceesay');
  assert.equal(r.body.driver.basis, 'authorization');
  assert.equal(r.body.driver.authorization.kind, 'friend');
  assert.equal(r.body.driver.licence.covers_vehicle, true);
  assert.equal(state(r, 'driver'), 'pass'); assert.equal(state(r, 'licence'), 'pass');
  assert.equal(state(r, 'insurance'), 'pass');
  assert.equal(r.body.verdict.outcome, 'advisory', 'only the unpaid citation to note');
  assert.equal(state(r, 'citations'), 'warn');
  const text = JSON.stringify(r.body);
  assert.ok(!/\+220\d/.test(text), 'no phone numbers reach the officer');
});

test('a person flag still awaiting a second officer never reaches a roadside stop (Lamin has a pending flag)', async () => {
  const pending = t.db.one(`SELECT id FROM flags WHERE kind = 'wanted' AND status = 'reported'`);
  assert.ok(pending, 'the seed leaves one waiting for approval');
  const sightings = t.db.one('SELECT COUNT(*) AS n FROM sightings').n;
  const r = await check('ousman', 'BJL-4821-B');
  assert.equal(r.body.driver.name, 'Lamin Ceesay');
  assert.deepEqual(r.body.flags, [], 'the pending accusation is not shown');
  assert.equal(r.body.verdict.flags.length, 0);
  assert.notEqual(r.body.verdict.outcome, 'flag_hit');
  assert.equal(t.db.one('SELECT COUNT(*) AS n FROM sightings').n, sightings, 'and no sighting is recorded against a person nobody has approved flagging');
  const live = (await t.api('GET', '/api/me/licence/code', { token: await t.as('lamin') })).body.code;
  const p = await t.api('POST', '/api/police/check-licence', { token: await t.as('ousman'), body: { code: live, reason: 'Routine checkpoint', ...AT } });
  assert.equal(p.body.flags.length, 0, 'nor on a direct licence check');
  assert.equal(p.body.verdict.outcome, 'clear');
});

test('the public check tells a buyer the difference between a police flag and an unconfirmed owner report', async () => {
  const bike = t.vehicleId('MC-BJL-0347-A');
  await t.api('POST', `/api/vehicles/${bike}/report-stolen`, { token: await t.as('fatou'), body: { summary: 'Taken overnight' } });
  const pub = (await t.api('GET', '/api/public/vehicle?q=MC-BJL-0347-A')).body;
  assert.equal(pub.police_flag, false); assert.equal(pub.owner_reported_stolen, true);
  const flag = t.db.one(`SELECT id FROM flags WHERE subject_id = ? AND status = 'reported'`, [bike]);
  await t.api('POST', `/api/vehicles/${bike}/report-stolen/withdraw`, { token: await t.as('fatou'), body: { reason: 'found' } });
  assert.equal((await t.api('GET', '/api/public/vehicle?q=MC-BJL-0347-A')).body.owner_reported_stolen, false);
});

test('a minibus with expired insurance needs action, and its owner is the declared driver', async () => {
  const r = await check('ousman', 'WCR-1904-C', { reason: 'Expired documents' });
  assert.equal(r.body.verdict.outcome, 'action_required');
  assert.equal(state(r, 'insurance'), 'fail'); assert.match(r.body.verdict.checks.find((c) => c.id === 'insurance').detail, /Expired 9 days ago/);
  assert.equal(state(r, 'driver'), 'pass'); assert.equal(state(r, 'licence'), 'pass', 'group C, as commercial use requires');
  assert.equal(r.body.vehicle.commercial, true);
});

test('a stolen vehicle is a flag hit with the instruction; the sighting is recorded and the owner is told', async () => {
  const before = t.db.one('SELECT COUNT(*) AS n FROM sightings').n;
  const r = await check('ousman', 'KM-7732-A', { location: { label: 'Bakau roundabout', lat: 13.478, lng: -16.681 } });
  assert.equal(r.body.verdict.outcome, 'flag_hit');
  assert.equal(r.body.verdict.instruction, 'call_dispatch');
  assert.equal(r.body.verdict.flags[0].kind, 'stolen');
  assert.equal(t.db.one('SELECT COUNT(*) AS n FROM sightings').n, before + 1);
  const owner = await t.api('GET', '/api/me/notifications', { token: await t.as('mariama') });
  assert.match(owner.body.notifications.map((n) => n.title).join('|'), /was seen/);
});

test('an unregistered plate is itself a finding, and is logged', async () => {
  const n = nChecks();
  const r = await check('ousman', 'ZZZ-0000-Z');
  assert.equal(r.body.verdict.outcome, 'unregistered'); assert.equal(r.body.vehicle, null);
  assert.equal(nChecks(), n + 1);
});

test('every lookup is logged by the server; an officer cannot skip it', async () => {
  const n = nChecks();
  await check('ousman', 'BJL-4821-B'); await check('isatou', 'WCR-1904-C');
  assert.equal(nChecks(), n + 2);
  const last = t.db.one('SELECT * FROM police_checks ORDER BY created_at DESC, rowid DESC LIMIT 1');
  assert.equal(last.reason, 'Routine checkpoint'); assert.equal(last.location_label, 'Test checkpoint'); assert.ok(last.badge);
  assert.ok(t.db.one(`SELECT id FROM audit_logs WHERE action = 'police.check.vehicle' AND details LIKE ?`, [`%${last.id}%`]));
});

test('a check must say why and where', async () => {
  assert.equal((await t.api('POST', '/api/police/check', { token: await t.as('ousman'), body: { query: 'BJL-4821-B', ...AT } })).status, 400, 'no reason');
  assert.equal((await t.api('POST', '/api/police/check', { token: await t.as('ousman'), body: { query: 'BJL-4821-B', reason: 'Just curious', ...AT } })).status, 400, 'reason must be from the list');
  assert.equal((await t.api('POST', '/api/police/check', { token: await t.as('ousman'), body: { query: 'BJL-4821-B', reason: 'Routine checkpoint' } })).status, 400, 'no location');
  assert.equal((await t.api('POST', '/api/police/check', { token: await t.as('fatou'), body: { query: 'BJL-4821-B', reason: 'Routine checkpoint', ...AT } })).status, 403, 'civilians cannot use it');
});

/* -------- the licence live code -------- */

test('licence live code: works now, expires, and identifies a person of interest without a word from the driver', async () => {
  const { issueLicenceCode, resolveLicenceCode } = await import(new URL('../src/services/licence-code.js', import.meta.url));
  const lic = t.db.one(`SELECT * FROM licences WHERE licence_number = 'GM-DL-411057'`);
  const now = Date.now();
  const { code } = issueLicenceCode(lic, now);
  assert.ok(resolveLicenceCode(code, now));
  assert.ok(resolveLicenceCode(code, now + 60_000), 'the previous window is still accepted (clock drift)');
  assert.equal(resolveLicenceCode(code, now + 5 * 60_000), null, 'a screenshot goes stale');
  assert.equal(resolveLicenceCode(code.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now), null, 'tampered');

  const live = (await t.api('GET', '/api/me/licence/code', { token: await t.as('samba') })).body.code;
  const r = await t.api('POST', '/api/police/check-licence', { token: await t.as('ousman'), body: { code: live, reason: 'Routine checkpoint', ...AT } });
  assert.equal(r.body.verdict.outcome, 'action_required', 'a person of interest is amber: act on the instruction, it is not a red alert');
  assert.equal(r.body.verdict.instruction, 'observe');
  assert.equal(r.body.licence.holder, 'Samba Jatta');
  assert.ok(!('detail' in r.body.flags[0]) || r.body.flags[0].created_by, 'restricted detail follows the flag visibility rules');
  const stale = await t.api('POST', '/api/police/check-licence', { token: await t.as('ousman'), body: { code: 'GM-DL-411057.AAAA-BBBB', reason: 'Routine checkpoint', ...AT } });
  assert.equal(stale.body.verdict.outcome, 'action_required'); assert.equal(stale.body.licence, null);
});

test('a licence code shown alongside a plate check identifies the person at the wheel', async () => {
  const live = (await t.api('GET', '/api/me/licence/code', { token: await t.as('lamin') })).body.code;
  const r = await check('ousman', 'WCR-1904-C', { licence_code: live });
  assert.equal(r.body.driver.licence.holder, 'Lamin Ceesay');
});

test('editing a licence sends it back to "pending", and pending is a warning, not a pass', async () => {
  const tok = await t.as('mariama');
  const put = await t.api('PUT', '/api/me/licence', { token: tok, body: { licence_number: 'GM-DL-266190', classes: ['A'], expires_at: '2031-06-30' } });
  assert.equal(put.body.licence.status, 'pending');
  assert.equal((await t.api('PUT', '/api/me/licence', { token: tok, body: { licence_number: 'GM-DL-266190', classes: ['Z'], expires_at: '2031-06-30' } })).status, 400, 'unknown group');
  assert.equal((await t.api('PUT', '/api/me/licence', { token: await t.as('samba'), body: { licence_number: 'GM-DL-266190', classes: ['A'], expires_at: '2031-06-30' } })).status, 409, 'a number belongs to one person');
  const q = await t.api('GET', '/api/admin/queue', { token: await t.as('admin') });
  const item = q.body.licences.find((l) => l.licence_number === 'GM-DL-266190');
  assert.ok(item);
  const ok = await t.api('POST', `/api/admin/licences/${item.id}/verify`, { token: await t.as('admin'), body: { status: 'valid' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.api('GET', '/api/me/licence', { token: tok })).body.licence.status, 'valid');
});

/* -------- flags: nobody puts a person on a list alone -------- */

test('person flags need a second person: the creator cannot approve their own', async () => {
  const flags = (await t.api('GET', '/api/police/flags?status=reported', { token: await t.as('ousman') })).body.flags;
  const pending = flags.find((f) => f.kind === 'wanted');
  assert.ok(pending); assert.equal(pending.can_approve, false, 'Ousman created it');
  assert.equal((await t.api('POST', `/api/police/flags/${pending.id}/approve`, { token: await t.as('ousman') })).status, 403);
  const viaSup = (await t.api('GET', '/api/police/flags?status=reported', { token: await t.as('isatou') })).body.flags.find((f) => f.id === pending.id);
  assert.equal(viaSup.can_approve, true);
  assert.equal((await t.api('POST', `/api/police/flags/${pending.id}/approve`, { token: await t.as('isatou') })).body.flag.status, 'active');
});

test('flag input rules: stolen needs a case number, person flags need a recorded reason, no duplicates', async () => {
  const ousman = await t.as('ousman');
  const f = (body) => t.api('POST', '/api/police/flags', { token: ousman, body });
  assert.equal((await f({ kind: 'stolen', plate: 'BJL-4821-B', summary: 'Reported stolen' })).status, 400, 'no case ref');
  assert.equal((await f({ kind: 'person_of_interest', licence_number: 'GM-DL-204518', summary: 'Wanted for questions' })).status, 400, 'no detail');
  assert.equal((await f({ kind: 'stolen', plate: 'KM-7732-A', summary: 'again', case_ref: 'X/1' })).status, 409, 'already flagged');
  assert.equal((await f({ kind: 'nonsense', plate: 'BJL-4821-B', summary: 'x' })).status, 400);
  const poi = await f({ kind: 'person_of_interest', licence_number: 'GM-DL-204518', summary: 'Witness to be traced', detail: 'Saw the incident on Kairaba Ave', expires_at: '2099-01-01' });
  assert.equal(poi.status, 201); assert.equal(poi.body.flag.status, 'reported');
  const days = (Date.parse(poi.body.flag.expires_at) - Date.now()) / 86400000;
  assert.ok(days <= 90.01, `persons of interest lapse within 90 days (got ${Math.round(days)})`);
});

test('an owner reports a theft: officers see it at once as unconfirmed; it becomes a red alert when an officer confirms', async () => {
  const fatou = await t.as('fatou'); const bike = t.vehicleId('MC-BJL-0347-A');
  const rep = await t.api('POST', `/api/vehicles/${bike}/report-stolen`, { token: fatou, body: { summary: 'Taken from outside the house overnight' } });
  assert.equal(rep.status, 201); assert.equal(rep.body.flag.status, 'reported');
  const seen = await check('ousman', 'MC-BJL-0347-A');
  assert.equal(seen.body.verdict.outcome, 'action_required', 'visible, but not a red alert until confirmed');
  assert.equal(seen.body.verdict.flags[0].status, 'reported');
  const ok = await t.api('POST', `/api/police/flags/${rep.body.flag.id}/approve`, { token: await t.as('ousman') });
  assert.equal(ok.body.flag.status, 'active');
  assert.equal((await check('ousman', 'MC-BJL-0347-A')).body.verdict.outcome, 'flag_hit');
  assert.equal((await t.api('POST', `/api/police/flags/${rep.body.flag.id}/clear`, { token: fatou, body: { reason: 'found it' } })).status, 403, 'an owner cannot lift a confirmed alert');
  assert.equal((await t.api('POST', `/api/police/flags/${rep.body.flag.id}/clear`, { token: await t.as('ousman'), body: {} })).status, 400, 'a reason is needed');
  assert.equal((await t.api('POST', `/api/police/flags/${rep.body.flag.id}/clear`, { token: await t.as('ousman'), body: { reason: 'Recovered at Brikama, returned to owner' } })).body.flag.status, 'cleared');
  const types = t.db.all('SELECT event_type FROM passport_blocks WHERE vehicle_id = ? ORDER BY block_index', [bike]).map((b) => b.event_type);
  assert.ok(types.includes('STOLEN_REPORT') && types.includes('STOLEN_RECOVERED'));
  const { verifyChain } = await import(new URL('../src/services/passport.js', import.meta.url));
  assert.equal(verifyChain(bike).valid, true);
});

test('an owner can withdraw their own report while it is unconfirmed', async () => {
  const alieu = await t.as('alieu'); const bus = t.vehicleId('WCR-1904-C');
  const rep = await t.api('POST', `/api/vehicles/${bus}/report-stolen`, { token: alieu, body: { summary: 'Thought it was stolen, driver had it' } });
  assert.equal((await t.api('POST', `/api/police/flags/${rep.body.flag.id}/clear`, { token: alieu, body: { reason: 'x' } })).status, 403, 'the police endpoints stay police-only');
  assert.equal((await t.api('POST', `/api/vehicles/${bus}/report-stolen/withdraw`, { token: await t.as('samba'), body: { reason: 'not mine' } })).status, 404, 'a stranger has no report to withdraw');
  assert.equal((await t.api('POST', `/api/vehicles/${bus}/report-stolen/withdraw`, { token: alieu, body: { reason: 'It was with my driver' } })).body.flag.status, 'cleared');
});

test('an officer only sees the restricted detail on flags they created; supervisors see all', async () => {
  const reg = await t.api('POST', '/api/auth/register', { body: { name: 'New Officer', phone: '+2207000555', password: 'longenough1' } });
  const station = t.db.one(`SELECT id FROM orgs WHERE type = 'station'`).id;
  assert.equal((await t.api('POST', `/api/admin/stations/${station}/members`, { token: await t.as('ousman'), body: { phone: '+2207000555', role: 'officer', badge_number: 'GPF-9' } })).status, 403, 'police cannot appoint police');
  assert.equal((await t.api('POST', `/api/orgs/${station}/members`, { token: await t.as('isatou'), body: { phone: '+2207000555', role: 'officer' } })).status, 403, 'even a supervisor cannot self-service staffing');
  assert.equal((await t.api('POST', `/api/admin/stations/${station}/members`, { token: await t.as('admin'), body: { phone: '+2207000555', role: 'officer', badge_number: 'GPF-9' } })).status, 201);
  const me = await t.api('POST', '/api/auth/login', { body: { phone: '+2207000555', password: 'longenough1' } });
  const list = (tok) => t.api('GET', '/api/police/flags?status=active', { token: tok });
  const stolen = (r) => r.body.flags.find((f) => f.kind === 'stolen');
  assert.equal('detail' in stolen(await list(me.body.token)), false, 'a new officer sees the summary and instruction only');
  assert.equal('detail' in stolen(await list(await t.as('isatou'))), true, 'a supervisor sees the detail');
  assert.equal('detail' in stolen(await list(await t.as('ousman'))), true, 'the creator sees the detail');
});

test('tracking works only for vehicles on the active stolen list, and is audited', async () => {
  const ousman = await t.as('ousman');
  const stolen = t.db.one(`SELECT id FROM flags WHERE kind = 'stolen' AND status = 'active'`);
  const tr = await t.api('GET', `/api/police/flags/${stolen.id}/track`, { token: ousman });
  assert.equal(tr.status, 200); assert.ok(tr.body.telemetry.length >= 1);
  assert.ok(t.db.one(`SELECT id FROM audit_logs WHERE action = 'police.track'`));
  const person = t.db.one(`SELECT id FROM flags WHERE subject_type = 'person' AND status = 'active'`);
  assert.equal((await t.api('GET', `/api/police/flags/${person.id}/track`, { token: ousman })).status, 404, 'people are never tracked');
});

test('the officer’s trail, the station view, and notes', async () => {
  const ousman = await t.as('ousman'); const isatou = await t.as('isatou');
  const mine = await t.api('GET', '/api/police/checks', { token: ousman });
  assert.ok(mine.body.checks.length > 0 && mine.body.checks.every((c) => c.officer === 'Ousman Darboe'));
  const station = await t.api('GET', '/api/police/checks?scope=station', { token: isatou });
  assert.ok(station.body.checks.some((c) => c.officer === 'Isatou Ceesay') && station.body.checks.some((c) => c.officer === 'Ousman Darboe'));
  assert.ok((await t.api('GET', '/api/police/checks?scope=station', { token: ousman })).body.checks.every((c) => c.officer === 'Ousman Darboe'), 'an officer cannot ask for the station view');
  assert.equal((await t.api('POST', `/api/police/checks/${mine.body.checks[0].id}/notes`, { token: ousman, body: { note: 'Driver cooperative, papers shown.' } })).status, 201);
  assert.equal((await t.api('POST', `/api/police/checks/${station.body.checks.find((c) => c.officer === 'Isatou Ceesay').id}/notes`, { token: ousman, body: { note: 'not mine' } })).status, 404);
});

test('citations: issued by police only, numbered sequentially, and the owner is told', async () => {
  const ousman = await t.as('ousman'); const rav = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', '/api/police/citations', { token: await t.as('fatou'), body: { vehicle_id: rav, code: 'SPEEDING' } })).status, 403);
  const c = await t.api('POST', '/api/police/citations', { token: ousman, body: { vehicle_id: rav, code: 'NO_SEATBELT' } });
  assert.equal(c.status, 201); assert.match(c.body.citation.number, /^GM-\d{4}-\d{6}$/);
  assert.equal(c.body.citation.fine_minor, 50000);
  const c2 = await t.api('POST', '/api/police/citations', { token: ousman, body: { vehicle_id: rav, code: 'PHONE_USE' } });
  assert.notEqual(c.body.citation.number, c2.body.citation.number);
  assert.match((await t.api('GET', '/api/me/notifications', { token: await t.as('fatou') })).body.notifications.map((n) => n.title).join('|'), /Citation GM-/);
});

test('the audit trail is intact after all of this, and only an administrator can read it', async () => {
  const v = await t.api('GET', '/api/admin/audit/verify', { token: await t.as('admin') });
  assert.equal(v.body.valid, true); assert.ok(v.body.entries > 20);
  assert.equal((await t.api('GET', '/api/admin/audit', { token: await t.as('isatou') })).status, 403);
  const a = await t.api('GET', '/api/admin/audit?limit=500', { token: await t.as('admin') });
  assert.ok(a.body.entries.some((e) => e.action === 'flag.approve') && a.body.entries.some((e) => e.action === 'police.check.vehicle'));
  // tamper: an attacker with raw access drops the trigger and edits one entry
  t.db.run('DROP TRIGGER audit_no_update');
  t.db.run(`UPDATE audit_logs SET action = 'nothing.to.see' WHERE seq = 5`);
  const broken = await t.api('GET', '/api/admin/audit/verify', { token: await t.as('admin') });
  assert.equal(broken.body.valid, false); assert.equal(broken.body.brokenAt, 5);
});
