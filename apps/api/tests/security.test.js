import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { boot } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

/* Every test here is a regression test for a vulnerability found in the v1 audit. */

test('v1 #1: nobody can register themselves as admin or police', async () => {
  const r = await t.api('POST', '/api/auth/register', { body: { name: 'Mallory', phone: '+2205550101', password: 'longenough1', role: 'admin', platform_role: 'admin' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.platform_role, 'user');
  assert.equal(r.body.user.capabilities.admin, false);
  assert.equal(r.body.user.capabilities.police, false);
  const tok = r.body.token;
  assert.equal((await t.api('GET', '/api/admin/queue', { token: tok })).status, 403);
  assert.equal((await t.api('POST', '/api/police/check', { token: tok, body: { query: 'BJL-4821-B', reason: 'Routine checkpoint', location: { label: 'x' } } })).status, 403);
});

test('v1 #2: a stranger cannot flag someone else’s vehicle as stolen, and cannot create police flags', async () => {
  const tok = (await t.api('POST', '/api/auth/register', { body: { name: 'Random', phone: '+2205550202', password: 'longenough1' } })).body.token;
  const id = t.vehicleId('BJL-4821-B');
  assert.equal((await t.api('POST', `/api/vehicles/${id}/report-stolen`, { token: tok, body: { summary: 'lol not mine' } })).status, 403);
  assert.equal((await t.api('POST', '/api/police/flags', { token: tok, body: { kind: 'stolen', plate: 'BJL-4821-B', summary: 'lol', case_ref: 'X' } })).status, 403);
});

test('v1 #3: there is no endpoint to write arbitrary blocks into a passport', async () => {
  const id = t.vehicleId('BJL-4821-B');
  const owner = await t.as('fatou');
  const r = await t.api('POST', `/api/vehicles/${id}/passport`, { token: owner, body: { eventType: 'POLICE_CLEARANCE', mileage: 1, description: 'x', dataPayload: {} } });
  assert.ok([404, 405].includes(r.status));
});

test('v1 #4: changing a NESTED value in a sealed block is detected (v1 hashed only top-level keys)', async () => {
  const { canonical } = await import(new URL('../src/lib/canonical.js', import.meta.url));
  assert.notEqual(canonical({ invoice: { total: 9500 } }), canonical({ invoice: { total: 1 } }));
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }), 'key order must not matter');

  const { verifyChain } = await import(new URL('../src/services/passport.js', import.meta.url));
  const id = t.vehicleId('BJL-4821-B');
  assert.equal(verifyChain(id).valid, true);
  // Bypass the append-only trigger the way an attacker with raw DB access would, then tamper with a nested invoice total.
  t.db.run('DROP TRIGGER passport_no_update');
  const blk = t.db.one(`SELECT id, payload FROM passport_blocks WHERE vehicle_id = ? AND event_type = 'ROUTINE_SERVICE' LIMIT 1`, [id]);
  const p = JSON.parse(blk.payload); p.invoice.total_minor = 1;
  t.db.run('UPDATE passport_blocks SET payload = ? WHERE id = ?', [JSON.stringify(p), blk.id]);
  const v = verifyChain(id);
  assert.equal(v.valid, false);
  assert.match(v.reason, /changed after it was sealed/);
  // restore for later tests
  p.invoice.total_minor = 45000; t.db.run('UPDATE passport_blocks SET payload = ? WHERE id = ?', [JSON.stringify(p), blk.id]);
  t.db.run(`CREATE TRIGGER passport_no_update BEFORE UPDATE ON passport_blocks BEGIN SELECT RAISE(ABORT, 'passport_blocks is append-only'); END;`);
  assert.equal(verifyChain(id).valid, true);
});

test('the database itself refuses to edit or delete passport, audit, checks and sightings', () => {
  for (const [table, col] of [['passport_blocks', 'description'], ['audit_logs', 'action'], ['police_checks', 'outcome'], ['sightings', 'label']]) {
    assert.throws(() => t.db.run(`UPDATE ${table} SET ${col} = 'x'`), /append-only/, `${table} update`);
    assert.throws(() => t.db.run(`DELETE FROM ${table}`), /append-only/, `${table} delete`);
  }
});

test('the passport is signed with Ed25519 and can be verified with only the public key', async () => {
  const keys = (await t.api('GET', '/api/public/keys')).body.passport;
  assert.equal(keys.algorithm, 'ed25519');
  const pub = crypto.createPublicKey(keys.publicKeyPem);
  const blocks = t.db.all('SELECT hash, signature FROM passport_blocks LIMIT 10');
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.equal(crypto.verify(null, Buffer.from(b.hash, 'hex'), pub, Buffer.from(b.signature, 'base64')), true);
});

test('v1 #6: no live GPS, no reporter phone numbers, nothing sensitive without signing in', async () => {
  for (const url of ['/api/vehicles', '/api/police/feed', '/api/police/flags', '/api/me/licence', '/api/admin/queue', '/api/momo/escrow']) {
    assert.equal((await t.api('GET', url)).status, 401, url);
  }
  assert.equal((await t.api('GET', '/api/fleet/telemetry')).status, 404);
  assert.equal((await t.api('POST', '/api/telemetry', { body: { vehicle_id: 'x' } })).status, 401);
});

test('public buyer check contains no personal data but does show a police flag', async () => {
  const r = await t.api('GET', '/api/public/vehicle?q=km-7732-a');
  assert.equal(r.body.found, true);
  assert.equal(r.body.police_flag, true);
  assert.equal(r.body.passport.valid, true);
  const text = JSON.stringify(r.body);
  for (const secret of ['Mariama', 'Touray', '+220', 'owner_phone', 'owner_name', 'SKD/2026']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.equal((await t.api('GET', '/api/public/vehicle?q=ZZZ-0000-Z')).body.found, false);
});

test('v1 #5: escrow cannot be funded without a signed provider callback', async () => {
  const fatou = await t.as('fatou');
  const job = t.db.one(`SELECT id, total_minor FROM jobs WHERE status = 'accepted'`);
  const pay = await t.api('POST', `/api/jobs/${job.id}/pay`, { token: fatou, body: { provider: 'afrimoney', phone: '2207777888' } });
  assert.equal(pay.status, 201);
  const ref = pay.body.escrow.reference;
  assert.equal(pay.body.escrow.status, 'pending');
  const old = await t.api('POST', '/api/momo/escrow/confirm-ussd', { body: { referenceCode: ref } });
  assert.ok([401, 404].includes(old.status), 'the old unauthenticated "confirm" endpoint no longer funds anything');
  assert.equal(t.db.one('SELECT status FROM escrow WHERE reference = ?', [ref]).status, 'pending', 'still unfunded');
  const body = JSON.stringify({ reference: ref, transaction_id: 'TX1', status: 'SUCCESS' });
  assert.equal((await t.api('POST', '/api/momo/webhook/afrimoney', { body })).status, 401, 'no signature');
  assert.equal((await t.api('POST', '/api/momo/webhook/afrimoney', { body, headers: { 'x-signature': 'deadbeef' } })).status, 401, 'bad signature');
  const sig = crypto.createHmac('sha256', 'dev-only-momo-webhook-secret-change-me').update(body).digest('hex');
  const ok = await t.api('POST', '/api/momo/webhook/afrimoney', { body, headers: { 'x-signature': sig } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.escrow, 'held');
  // replaying the same callback is harmless
  assert.equal((await t.api('POST', '/api/momo/webhook/afrimoney', { body, headers: { 'x-signature': sig } })).status, 200);
});

test('v1 #5b: only the customer releases, only the garage refunds, disputes go to an administrator', async () => {
  const fatou = await t.as('fatou'); const modou = await t.as('modou'); const lamin = await t.as('lamin'); const admin = await t.as('admin'); const ebrima = await t.as('ebrima');
  const e = t.db.one(`SELECT reference FROM escrow WHERE status = 'held'`);
  const ref = e.reference;
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/release`, { token: modou })).status, 403, 'the garage cannot release money to itself');
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/release`, { token: lamin })).status, 403, 'a stranger cannot release');
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/refund`, { token: fatou })).status, 403, 'the customer cannot refund themselves');
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/refund`, { token: lamin })).status, 403, 'a stranger cannot refund');
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/dispute`, { token: fatou })).status, 200);
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/release`, { token: fatou })).status, 403, 'in dispute: the customer can no longer release');
  assert.equal((await t.api('POST', `/api/momo/escrow/${ref}/release`, { token: admin })).body.escrow.status, 'released');
});

test('amounts are validated and integers', async () => {
  const fatou = await t.as('fatou');
  const job = t.db.one(`SELECT id FROM jobs WHERE status = 'requested'`);
  assert.equal((await t.api('POST', `/api/jobs/${job.id}/pay`, { token: fatou, body: { provider: 'afrimoney', phone: '2207777888', amount_gmd: -50 } })).status, 400);
  assert.equal((await t.api('POST', `/api/jobs/${job.id}/pay`, { token: fatou, body: { provider: 'bitcoin', phone: '2207777888', amount_gmd: 50 } })).status, 400);
});

test('v1: citations cannot be waived without passing the course, by someone else, or with a made-up score', async () => {
  const lamin = await t.as('lamin'); const samba = await t.as('samba');
  const c = t.db.one(`SELECT id FROM citations WHERE code = 'SPEEDING'`);
  assert.equal((await t.api('POST', `/api/citations/${c.id}/waive`, { token: samba, body: { answers: [1, 2, 1, 2, 0] } })).status, 404, 'not theirs');
  assert.equal((await t.api('POST', `/api/citations/${c.id}/waive`, { token: lamin, body: { score: 100 } })).status, 400, 'a client-supplied score means nothing');
  const wrong = await t.api('POST', `/api/citations/${c.id}/waive`, { token: lamin, body: { answers: [0, 0, 0, 0, 1] } });
  assert.equal(wrong.status, 422);
  const course = await t.api('GET', `/api/citations/${c.id}/course`, { token: lamin });
  assert.ok(course.body.questions.every((q) => !('answer' in q)), 'the answer key never leaves the server');
  const right = await t.api('POST', `/api/citations/${c.id}/waive`, { token: lamin, body: { answers: [1, 2, 1, 2, 0] } });
  assert.equal(right.status, 200);
  assert.equal(t.db.one('SELECT status FROM citations WHERE id = ?', [c.id]).status, 'waived');
  const veh = t.db.one('SELECT vehicle_id FROM citations WHERE id = ?', [c.id]).vehicle_id;
  const types = t.db.all('SELECT event_type FROM passport_blocks WHERE vehicle_id = ?', [veh]).map((b) => b.event_type);
  assert.ok(types.includes('CITATION_RESOLVED'));
  assert.ok(!types.includes('ROADWORTHINESS_TEST'), 'v1 wrongly recorded a waiver as a roadworthiness test');
});

test('non-waivable offences cannot be waived', async () => {
  const alieu = await t.as('alieu');
  const c = t.db.one(`SELECT id FROM citations WHERE code = 'EXP_INSURANCE'`);
  assert.equal((await t.api('POST', `/api/citations/${c.id}/waive`, { token: alieu, body: { answers: [1, 2, 1, 2, 0] } })).status, 403);
});

test('sign-in locks after repeated wrong passwords and never says which part was wrong', async () => {
  const wrongUser = await t.api('POST', '/api/auth/login', { body: { phone: '+2209999999', password: 'whatever12' } });
  const wrongPass = await t.api('POST', '/api/auth/login', { body: { phone: '+2207000010', password: 'nope-nope' } });
  assert.equal(wrongUser.status, 401); assert.equal(wrongPass.status, 401);
  assert.equal(wrongUser.body.error, wrongPass.body.error);
  for (let i = 0; i < 4; i++) await t.api('POST', '/api/auth/login', { body: { phone: '+2207000010', password: 'nope-nope' } });
  const locked = await t.api('POST', '/api/auth/login', { body: { phone: '+2207000010', password: 'streetcode' } });
  assert.equal(locked.status, 429, 'the correct password is refused while locked');
});

test('websocket: unauthenticated and badly authenticated sockets get nothing', async () => {
  const wsUrl = t.base.replace('http', 'ws') + '/ws';
  const run = (msg) => new Promise((resolve) => {
    const ws = new WebSocket(wsUrl); const got = [];
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (m) => { got.push(JSON.parse(m.toString())); if (got[0]?.type === 'READY') { ws.close(); } });
    ws.on('close', (code) => resolve({ code, got }));
  });
  const bad = await run({ type: 'AUTH', token: 'not-a-token' });
  assert.equal(bad.code, 4003); assert.equal(bad.got.length, 0);
  const good = await run({ type: 'AUTH', token: await t.as('ousman') });
  assert.equal(good.got[0].type, 'READY'); assert.equal(good.got[0].police, true);
  const civilian = await run({ type: 'AUTH', token: await t.as('fatou') });
  assert.equal(civilian.got[0].police, false);
});

test('production refuses to start with default secrets, and config does not depend on the working directory', () => {
  const cfg = new URL('../src/config.js', import.meta.url).pathname;
  const prod = (extra = {}) => execFileSync(process.execPath, ['-e', `import('${cfg}').then(()=>console.log('started'))`], { env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: t.dir, ...extra }, stdio: 'pipe' });
  assert.throws(() => prod(), /JWT_SECRET/);
  assert.throws(() => prod({ JWT_SECRET: 'dev-only-jwt-secret-change-me' }), /JWT_SECRET/);
  const strong = 'x'.repeat(40);
  assert.throws(() => prod({ JWT_SECRET: strong, LICENCE_CODE_KEY: strong, MOMO_WEBHOOK_SECRET: strong, MOMO_MODE: 'sandbox' }), /MOMO_MODE/);
  const passport = new URL('../src/services/passport.js', import.meta.url).pathname;
  const noKey = () => execFileSync(process.execPath, ['-e', `import('${passport}').then(()=>console.log('started'))`], { env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: t.dir, JWT_SECRET: strong, LICENCE_CODE_KEY: strong, MOMO_WEBHOOK_SECRET: strong }, stdio: 'pipe' });
  assert.throws(noKey, /PASSPORT_PRIVATE_KEY_PEM/, 'no signing key supplied in production');
  const printDir = (cwd) => execFileSync(process.execPath, ['-e', `import('${cfg}').then(m=>console.log(m.ROOT))`], { cwd, env: { PATH: process.env.PATH, DATA_DIR: t.dir }, stdio: 'pipe' }).toString().trim();
  assert.equal(printDir('/'), printDir(t.dir), 'same root from any working directory');
});

test('security headers are set and the API does not advertise Express', async () => {
  const res = await fetch(t.base + '/healthz');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('malformed JSON and oversized bodies get clean errors, not stack traces', async () => {
  const bad = await t.api('POST', '/api/auth/login', { body: '{not json', headers: {} });
  assert.equal(bad.status, 400);
  const big = await t.api('POST', '/api/auth/login', { body: JSON.stringify({ phone: 'x'.repeat(200000) }) });
  assert.equal(big.status, 413);
});
