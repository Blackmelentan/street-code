import crypto from 'node:crypto';
import { one, run, tx } from '../db/database.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { HttpError, bad, forbidden, notFound } from '../lib/http.js';
import { isAdmin, isOrgManager } from '../middleware/auth.js';
import { audit } from './audit.js';
import { notify } from './notify.js';

const MAX_MINOR = 100_000_000; // D1,000,000
export const getEscrow = (ref) => one('SELECT * FROM escrow WHERE reference = ?', [ref]);

/** Customer puts money in escrow for a job. Amounts are integer butut. */
export function initiateEscrow({ user, jobId, provider, phone, amountMinor, ip }) {
  if (!['afrimoney', 'qmoney'].includes(provider)) throw bad('Provider must be afrimoney or qmoney.');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_MINOR) throw bad('Amount is not valid.');
  const job = one('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw notFound('Job not found.');
  if (job.customer_id !== user.id) throw forbidden('Only the customer on this job can pay for it.');
  if (['completed', 'cancelled'].includes(job.status)) throw new HttpError(409, 'This job is closed.');
  if (job.total_minor > 0 && amountMinor !== job.total_minor) throw bad('Amount must match the quoted total.');
  if (one(`SELECT id FROM escrow WHERE job_id = ? AND status IN ('pending','held','disputed')`, [jobId])) throw new HttpError(409, 'This job already has a payment in progress.');
  const fee = Math.round(amountMinor * config.platformFeeRate);
  const id = newId('esc');
  const reference = `SC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  run(`INSERT INTO escrow (id, job_id, payer_id, payee_org_id, provider, phone, amount_minor, fee_minor, net_minor, reference) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, jobId, user.id, job.org_id, provider, phone, amountMinor, fee, amountMinor - fee, reference]);
  run('UPDATE jobs SET escrow_id = ? WHERE id = ?', [id, jobId]);
  audit({ actor: { id: user.id, label: user.name }, action: 'escrow.initiate', targetType: 'escrow', targetId: id, details: { reference, amountMinor }, ip });
  return getEscrow(reference);
}

/** Only ever called from a verified provider callback, or the sandbox approve endpoint. */
export function markFunded({ reference, providerTxn }) {
  return tx(() => {
    const e = getEscrow(reference);
    if (!e) throw notFound('Unknown reference.');
    if (e.status === 'held' && e.provider_txn === providerTxn) return e; // idempotent replay
    if (e.status !== 'pending') throw new HttpError(409, `Escrow is ${e.status}.`);
    run(`UPDATE escrow SET status = 'held', provider_txn = ?, updated_at = ? WHERE id = ?`, [providerTxn, new Date().toISOString(), e.id]);
    audit({ action: 'escrow.funded', targetType: 'escrow', targetId: e.id, details: { reference, providerTxn } });
    return getEscrow(reference);
  });
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', config.momoWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The customer releases the money once they are happy. Admin can release a dispute. */
export function releaseEscrow({ user, reference, ip }) {
  return tx(() => {
    const e = getEscrow(reference);
    if (!e) throw notFound('Unknown reference.');
    if (e.payer_id !== user.id && !isAdmin(user)) throw forbidden('Only the customer can release this payment.');
    if (!['held', 'disputed'].includes(e.status)) throw new HttpError(409, `Escrow is ${e.status}.`);
    if (e.status === 'disputed' && !isAdmin(user)) throw forbidden('This payment is in dispute. An administrator will decide.');
    run(`UPDATE escrow SET status = 'released', updated_at = ? WHERE id = ?`, [new Date().toISOString(), e.id]);
    audit({ actor: { id: user.id, label: user.name }, action: 'escrow.release', targetType: 'escrow', targetId: e.id, details: { reference }, ip });
    return getEscrow(reference);
  });
}

/** The garage can refund voluntarily. The customer cannot refund themselves. */
export function refundEscrow({ user, reference, ip }) {
  return tx(() => {
    const e = getEscrow(reference);
    if (!e) throw notFound('Unknown reference.');
    if (!isAdmin(user) && !isOrgManager(user, e.payee_org_id)) throw forbidden('Only the garage or an administrator can refund this payment.');
    if (!['held', 'disputed'].includes(e.status)) throw new HttpError(409, `Escrow is ${e.status}.`);
    run(`UPDATE escrow SET status = 'refunded', updated_at = ? WHERE id = ?`, [new Date().toISOString(), e.id]);
    audit({ actor: { id: user.id, label: user.name }, action: 'escrow.refund', targetType: 'escrow', targetId: e.id, details: { reference }, ip });
    notify({ userId: e.payer_id, kind: 'payment', title: 'Payment refunded', body: `Reference ${reference}`, dedupeKey: `esc:${e.id}:refund` });
    return getEscrow(reference);
  });
}

export function disputeEscrow({ user, reference, ip }) {
  const e = getEscrow(reference);
  if (!e) throw notFound('Unknown reference.');
  if (e.payer_id !== user.id) throw forbidden('Only the customer can open a dispute.');
  if (e.status !== 'held') throw new HttpError(409, `Escrow is ${e.status}.`);
  run(`UPDATE escrow SET status = 'disputed', updated_at = ? WHERE id = ?`, [new Date().toISOString(), e.id]);
  audit({ actor: { id: user.id, label: user.name }, action: 'escrow.dispute', targetType: 'escrow', targetId: e.id, details: { reference }, ip });
  return getEscrow(reference);
}
