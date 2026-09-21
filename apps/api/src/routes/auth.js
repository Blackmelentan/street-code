import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, signToken, loadUser, isPolice, isSupervisor, isAdmin, stationOf } from '../middleware/auth.js';
import { h, str, oneOf, isoDate, bad, unauthorized, conflict, notFound, json, HttpError } from '../lib/http.js';
import { newId, normPhone } from '../lib/ids.js';
import { rateLimit } from '../lib/ratelimit.js';
import { audit } from '../services/audit.js';
import { issueLicenceCode } from '../services/licence-code.js';
import { LICENCE_GROUPS } from '../../../../packages/core/src/index.js';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many sign-in attempts. Try again in a few minutes.' });
export const authLimiters = { loginLimiter };

const publicUser = (u) => ({
  id: u.id, name: u.name, phone: u.phone, email: u.email, platform_role: u.platform_role,
  memberships: u.memberships,
  capabilities: { police: isPolice(u), supervisor: isSupervisor(u), admin: isAdmin(u), garage: u.memberships.some((m) => m.org_type === 'garage'), fleet: u.memberships.some((m) => m.org_type === 'fleet') },
  station: stationOf(u) ? { org_id: stationOf(u).org_id, name: stationOf(u).org_name, role: stationOf(u).role, badge: stationOf(u).badge_number } : null,
});

// Anyone can register. Nobody can choose their own role: police and admin are provisioned by an administrator.
r.post('/auth/register', loginLimiter, h((req, res) => {
  const name = str(req.body.name, 'Name', { min: 2, max: 80 });
  const phone = normPhone(str(req.body.phone, 'Phone', { min: 7, max: 20 }));
  const password = str(req.body.password, 'Password', { min: 8, max: 100 });
  const email = str(req.body.email, 'Email', { optional: true, max: 120 });
  if (!/^\+\d{9,15}$/.test(phone)) throw bad('Enter a valid phone number.');
  if (one('SELECT id FROM users WHERE phone = ?', [phone])) throw conflict('An account with this phone number already exists.');
  const id = newId('usr');
  tx(() => {
    run('INSERT INTO users (id, name, phone, email, password_hash) VALUES (?,?,?,?,?)', [id, name, phone, email, bcrypt.hashSync(password, 10)]);
    // Anything addressed to this phone number before they had an account now reaches them.
    run(`UPDATE memberships SET user_id = ? WHERE invited_phone = ? AND user_id IS NULL`, [id, phone]);
    run(`UPDATE authorizations SET driver_user_id = ? WHERE driver_phone = ? AND driver_user_id IS NULL`, [id, phone]);
    run(`UPDATE ownership_transfers SET to_user_id = ? WHERE to_phone = ? AND to_user_id IS NULL`, [id, phone]);
  });
  audit({ actor: { id, label: name }, action: 'user.register', targetType: 'user', targetId: id, ip: req.ip });
  const user = loadUser(id);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

r.post('/auth/login', loginLimiter, h((req, res) => {
  const phone = normPhone(str(req.body.phone, 'Phone'));
  const password = str(req.body.password, 'Password', { max: 100 });
  const u = one('SELECT * FROM users WHERE phone = ?', [phone]);
  const generic = () => unauthorized('Phone number or password is not right.');
  if (!u) { bcrypt.compareSync(password, '$2a$10$abcdefghijklmnopqrstuuMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); throw generic(); }
  if (u.locked_until && Date.parse(u.locked_until) > Date.now()) throw new HttpError(429, 'Too many wrong passwords. Try again in a few minutes.');
  if (!bcrypt.compareSync(password, u.password_hash)) {
    const fails = u.failed_logins + 1;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [fails, fails >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, u.id]);
    audit({ actor: { id: u.id, label: u.name }, action: 'user.login_failed', targetType: 'user', targetId: u.id, ip: req.ip });
    throw generic();
  }
  if (u.status !== 'active') throw unauthorized('This account is suspended.');
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
  const user = loadUser(u.id);
  audit({ actor: { id: u.id, label: u.name }, action: 'user.login', targetType: 'user', targetId: u.id, ip: req.ip });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

r.get('/auth/me', authenticate, h((req, res) => res.json({ user: publicUser(req.user) })));

/* ---- my licence ---- */
const licenceOut = (l) => (l ? { ...l, classes: json(l.classes, []), restrictions: json(l.restrictions, []) } : null);

r.get('/me/licence', authenticate, h((req, res) => {
  res.json({ licence: licenceOut(one('SELECT * FROM licences WHERE user_id = ?', [req.user.id])), groups: LICENCE_GROUPS });
}));

// Declaring a licence never makes it "valid". Only the licensing authority (an administrator) verifies it.
r.put('/me/licence', authenticate, h((req, res) => {
  const number = str(req.body.licence_number, 'Licence number', { min: 4, max: 20 }).toUpperCase().replace(/\s+/g, '');
  const classes = Array.isArray(req.body.classes) ? req.body.classes : [];
  if (!classes.length || classes.some((c) => !LICENCE_GROUPS[c])) throw bad(`Choose one or more groups: ${Object.keys(LICENCE_GROUPS).join(', ')}.`);
  const expires = isoDate(req.body.expires_at, 'Expiry date');
  const issued = isoDate(req.body.issued_at, 'Issue date', { optional: true });
  const taken = one('SELECT user_id FROM licences WHERE licence_number = ?', [number]);
  if (taken && taken.user_id !== req.user.id) throw conflict('That licence number is already registered to another account.');
  const existing = one('SELECT * FROM licences WHERE user_id = ?', [req.user.id]);
  if (existing) {
    const changed = existing.licence_number !== number || existing.expires_at !== expires || json(existing.classes, []).join() !== [...classes].sort().join();
    // Any change to a verified licence sends it back for re-verification. Suspended and revoked stay that way.
    const status = ['suspended', 'revoked'].includes(existing.status) ? existing.status : changed ? 'pending' : existing.status;
    run('UPDATE licences SET licence_number = ?, classes = ?, expires_at = ?, issued_at = ?, status = ? WHERE user_id = ?', [number, JSON.stringify([...classes].sort()), expires, issued, status, req.user.id]);
  } else {
    run('INSERT INTO licences (id, user_id, licence_number, classes, issued_at, expires_at, status) VALUES (?,?,?,?,?,?,?)', [newId('lic'), req.user.id, number, JSON.stringify([...classes].sort()), issued, expires, 'pending']);
  }
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'licence.declare', targetType: 'user', targetId: req.user.id, ip: req.ip });
  res.json({ licence: licenceOut(one('SELECT * FROM licences WHERE user_id = ?', [req.user.id])) });
}));

r.get('/me/licence/code', authenticate, h((req, res) => {
  const l = one('SELECT * FROM licences WHERE user_id = ?', [req.user.id]);
  if (!l) throw notFound('Add your licence first.');
  if (l.status === 'revoked') throw new HttpError(403, 'This licence has been revoked.');
  res.json(issueLicenceCode(l));
}));

/* ---- notifications ---- */
r.get('/me/notifications', authenticate, h((req, res) => {
  const items = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({ notifications: items, unread: items.filter((n) => !n.read_at).length });
}));
r.post('/me/notifications/read', authenticate, h((req, res) => {
  const now = new Date().toISOString();
  if (Array.isArray(req.body.ids) && req.body.ids.length) for (const id of req.body.ids.slice(0, 100)) run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', [now, String(id), req.user.id]);
  else run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now, req.user.id]);
  res.json({ ok: true });
}));

export default r;
