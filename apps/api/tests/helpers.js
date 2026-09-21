import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * Each test file runs in its own process with its own throw-away database, so tests
 * never depend on each other's leftovers (the original suite mutated one shared file).
 */
export async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
  process.env.DATA_DIR = dir;
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.DEV_FEATURES = '1';
  const src = new URL('../src/', import.meta.url);
  const db = await import(new URL('db/database.js', src));
  const { createApp } = await import(new URL('app.js', src));
  const { seed } = await import(new URL('db/seed.js', src));
  const hub = await import(new URL('services/hub.js', src));
  db.openDb();
  const seeded = seed();
  const server = http.createServer(createApp());
  hub.attachHub(server);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  const api = async (method, url, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  };
  const login = async (phone) => {
    if (tokens[phone]) return tokens[phone];
    const r = await api('POST', '/api/auth/login', { body: { phone, password: 'streetcode' } });
    if (r.status !== 200) throw new Error(`login ${phone} -> ${r.status} ${JSON.stringify(r.body)}`);
    return (tokens[phone] = r.body.token);
  };
  const P = { fatou: '+2207000001', lamin: '+2207000002', ebrima: '+2207000003', modou: '+2207000004', ousman: '+2207000005', isatou: '+2207000006', admin: '+2207000007', alieu: '+2207000008', mariama: '+2207000009', samba: '+2207000010' };
  const as = async (who) => login(P[who]);
  const vehicleId = (plate) => db.one('SELECT id FROM vehicles WHERE plate = ?', [plate]).id;
  const close = async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); db.closeDb(); };
  return { api, as, login, base, db, seeded, vehicleId, close, server, P, dir };
}

export const AT = { location: { label: 'Test checkpoint', lat: 13.44, lng: -16.68 } };
