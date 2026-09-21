import { Router } from 'express';
import { all, one, run, tx } from '../db/database.js';
import { authenticate, isPolice } from '../middleware/auth.js';
import { config } from '../config.js';
import { h, str, num, oneOf, bad, forbidden, notFound, conflict, HttpError } from '../lib/http.js';
import { newId } from '../lib/ids.js';
import { requireVehicle, canManage } from '../services/access.js';
import { appendBlock } from '../services/passport.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notify.js';

const r = Router();
r.use(['/citations', '/me/citations', '/police/citations'], authenticate);

/**
 * PLACEHOLDER fine schedule (in butut). Replace with the Gambia Police Force's official schedule before launch.
 * Kept in one table so it is one file to correct.
 */
export const OFFENCES = {
  EXP_INSURANCE: { title: 'No valid insurance',          fine: 200000, waivable: false },
  EXP_ROADTAX:   { title: 'Road tax expired',            fine: 150000, waivable: false },
  EXP_RWT:       { title: 'No roadworthiness certificate', fine: 150000, waivable: false },
  NO_LICENCE:    { title: 'Driving without a valid licence', fine: 300000, waivable: false },
  UNAUTH_DRIVER: { title: 'Driving without the owner’s permission', fine: 500000, waivable: false },
  SPEEDING:      { title: 'Speeding',                    fine: 100000, waivable: true },
  NO_SEATBELT:   { title: 'Seatbelt not worn',           fine: 50000,  waivable: true },
  PHONE_USE:     { title: 'Phone use while driving',     fine: 75000,  waivable: true },
  LIGHT_DEFECT:  { title: 'Faulty lights',               fine: 50000,  waivable: true },
};

// The answer key lives on the server. v1 accepted a client-supplied score (default 100), so anyone could waive any fine.
const COURSE = [
  { q: 'You are approaching a junction with a stop sign. What must you do?', options: ['Slow down and go if clear', 'Come to a complete stop, then go when safe', 'Sound the horn and continue'], answer: 1 },
  { q: 'When is it safe to use a handheld phone while driving?', options: ['At low speed', 'In slow traffic', 'Never. Stop safely first'], answer: 2 },
  { q: 'What is the safest way to react to a vehicle tailgating you?', options: ['Brake hard to warn them', 'Keep a steady speed and let them pass when safe', 'Speed up'], answer: 1 },
  { q: 'Who must wear a seatbelt?', options: ['Only the driver', 'Front seat occupants only', 'Everyone in the vehicle'], answer: 2 },
  { q: 'A pedestrian is waiting at a marked crossing. You should:', options: ['Give way and let them cross', 'Flash your lights and continue', 'Speed up to pass before they step out'], answer: 0 },
];
const PASS_MARK = 4;

r.get('/citations/offences', h((req, res) => res.json({ offences: OFFENCES, note: 'Placeholder schedule' })));

r.post('/police/citations', h((req, res) => {
  if (!isPolice(req.user)) throw forbidden('Police officers only.');
  const code = oneOf(req.body.code, 'Offence', Object.keys(OFFENCES));
  const v = requireVehicle(req.body.vehicle_id);
  const check = req.body.check_id ? one('SELECT id FROM police_checks WHERE id = ? AND officer_id = ?', [req.body.check_id, req.user.id]) : null;
  if (req.body.check_id && !check) throw bad('That check is not yours.');
  const driver = req.body.driver_licence ? one('SELECT user_id FROM licences WHERE licence_number = ?', [String(req.body.driver_licence).toUpperCase().replace(/\s+/g, '')]) : one(`SELECT driver_user_id AS user_id FROM drive_sessions WHERE vehicle_id = ? AND status = 'active'`, [v.id]);
  const id = newId('cit');
  const off = OFFENCES[code];
  const number = tx(() => {
    const yr = new Date().getUTCFullYear();
    const n = one(`SELECT COUNT(*) AS n FROM citations WHERE number LIKE ?`, [`GM-${yr}-%`]).n + 1;
    const num_ = `GM-${yr}-${String(n).padStart(6, '0')}`;
    run(`INSERT INTO citations (id, number, vehicle_id, driver_id, officer_id, check_id, code, title, fine_minor, waivable) VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, num_, v.id, driver?.user_id ?? null, req.user.id, check?.id ?? null, code, off.title, off.fine, off.waivable ? 1 : 0]);
    return num_;
  });
  for (const uid of new Set([v.owner_user_id, driver?.user_id].filter(Boolean))) notify({ userId: uid, kind: 'citation', severity: 'warn', title: `Citation ${number}: ${off.title}`, body: `D${(off.fine / 100).toFixed(2)}${off.waivable ? '. You may be able to waive this by completing a short course.' : ''}`, vehicleId: v.id, dedupeKey: `cit:${id}` });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'citation.issue', targetType: 'vehicle', targetId: v.id, details: { id, number, code }, ip: req.ip });
  res.status(201).json({ citation: one('SELECT * FROM citations WHERE id = ?', [id]) });
}));

const mine = (user) => all(
  `SELECT c.*, v.plate FROM citations c JOIN vehicles v ON v.id = c.vehicle_id
    WHERE c.driver_id = ? OR v.owner_user_id = ? ORDER BY c.created_at DESC LIMIT 50`, [user.id, user.id]);

r.get('/me/citations', h((req, res) => res.json({ citations: mine(req.user) })));

const own = (user, c) => {
  const v = requireVehicle(c.vehicle_id);
  return c.driver_id === user.id || canManage(user, v);
};

r.get('/citations/:id/course', h((req, res) => {
  const c = one('SELECT * FROM citations WHERE id = ?', [req.params.id]);
  if (!c || !own(req.user, c)) throw notFound();
  if (!c.waivable) throw conflict('This offence cannot be waived.');
  res.json({ passMark: PASS_MARK, questions: COURSE.map(({ q, options }) => ({ q, options })) });
}));

r.post('/citations/:id/waive', h((req, res) => {
  const c = one('SELECT * FROM citations WHERE id = ?', [req.params.id]);
  if (!c || !own(req.user, c)) throw notFound();
  if (c.status !== 'issued') throw conflict(`This citation is already ${c.status}.`);
  if (!c.waivable) throw forbidden('This offence cannot be waived.');
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  if (answers.length !== COURSE.length) throw bad('Answer every question.');
  const score = COURSE.reduce((n, q, i) => n + (Number(answers[i]) === q.answer ? 1 : 0), 0);
  if (score < PASS_MARK) return res.status(422).json({ error: `You scored ${score} of ${COURSE.length}. You need ${PASS_MARK} to pass. Try again.`, score, passMark: PASS_MARK });
  const v = requireVehicle(c.vehicle_id);
  tx(() => {
    run(`UPDATE citations SET status = 'waived', resolved_at = ? WHERE id = ?`, [new Date().toISOString(), c.id]);
    // A waiver is not a roadworthiness test. It gets its own, system-sealed event.
    appendBlock({ vehicleId: v.id, eventType: 'CITATION_RESOLVED', mileage: v.odometer, authority: 'system', actor: { id: req.user.id, role: 'system', name: 'Street Code' }, description: `Citation ${c.number} waived after completing the defensive driving course.`, payload: { citation: c.number, score } });
  });
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'citation.waive', targetType: 'citation', targetId: c.id, details: { score }, ip: req.ip });
  res.json({ ok: true, score });
}));

// Paying a fine needs a real payment. In live mode this stays closed until a provider is connected.
r.post('/citations/:id/pay', h((req, res) => {
  const c = one('SELECT * FROM citations WHERE id = ?', [req.params.id]);
  if (!c || !own(req.user, c)) throw notFound();
  if (c.status !== 'issued') throw conflict(`This citation is already ${c.status}.`);
  if (config.momoMode !== 'sandbox') throw new HttpError(501, 'Online fine payment is not connected yet. Pay at a Gambia Police Force office and quote the citation number.');
  run(`UPDATE citations SET status = 'paid', resolved_at = ? WHERE id = ?`, [new Date().toISOString(), c.id]);
  audit({ actor: { id: req.user.id, label: req.user.name }, action: 'citation.pay_sandbox', targetType: 'citation', targetId: c.id, ip: req.ip });
  res.json({ ok: true, sandbox: true });
}));

export default r;
