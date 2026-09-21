import { Router } from 'express';
import { all, one } from '../db/database.js';
import { authenticate } from '../middleware/auth.js';
import { config } from '../config.js';
import { h, str, forbidden, notFound, HttpError } from '../lib/http.js';
import { getEscrow, markFunded, verifyWebhookSignature, releaseEscrow, refundEscrow, disputeEscrow } from '../services/momo.js';

const r = Router();

// Provider callback. Must carry a valid HMAC signature over the raw body: this is the only way money becomes "held" in live mode.
r.post('/momo/webhook/:provider', h((req, res) => {
  if (!verifyWebhookSignature(req.rawBody, req.headers['x-signature'])) throw new HttpError(401, 'Bad signature.');
  const { reference, transaction_id: txn, status } = req.body || {};
  if (status !== 'SUCCESS') return res.json({ ok: true, ignored: true });
  res.json({ ok: true, escrow: markFunded({ reference: String(reference), providerTxn: String(txn) }).status });
}));

r.use('/momo', authenticate);

const view = (e) => e && ({ ...e, amount_gmd: e.amount_minor / 100, fee_gmd: e.fee_minor / 100, net_gmd: e.net_minor / 100 });

r.get('/momo/escrow', h((req, res) => {
  const rows = all(`SELECT e.*, o.name AS garage FROM escrow e JOIN orgs o ON o.id = e.payee_org_id WHERE e.payer_id = ? ORDER BY e.created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ escrow: rows.map(view) });
}));

// Sandbox only: stands in for the customer approving on their handset. In live mode this endpoint does not exist.
r.post('/momo/escrow/:ref/sandbox-approve', h((req, res) => {
  if (config.momoMode !== 'sandbox') throw notFound();
  const e = getEscrow(req.params.ref);
  if (!e || e.payer_id !== req.user.id) throw notFound('Unknown reference.');
  res.json({ escrow: view(markFunded({ reference: e.reference, providerTxn: `SBX-${Date.now()}` })) });
}));

r.post('/momo/escrow/:ref/release', h((req, res) => res.json({ escrow: view(releaseEscrow({ user: req.user, reference: req.params.ref, ip: req.ip })) })));
r.post('/momo/escrow/:ref/refund', h((req, res) => res.json({ escrow: view(refundEscrow({ user: req.user, reference: req.params.ref, ip: req.ip })) })));
r.post('/momo/escrow/:ref/dispute', h((req, res) => res.json({ escrow: view(disputeEscrow({ user: req.user, reference: req.params.ref, ip: req.ip })) })));

export default r;
