import express from 'express';
import { query, queryOne } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { initiateEscrow, confirmUssdPush, releaseEscrow, refundEscrow } from '../services/momo.service.js';
import { logAuditEvent } from '../services/audit.service.js';

const router = express.Router();

/**
 * Initiate an Afrimoney or QMoney Escrow transaction (Triggers USSD Push to phone)
 */
router.post('/escrow/initiate', authenticateToken, (req, res) => {
  try {
    const { jobId, payeeId, provider, phoneNumber, amountGmd } = req.body;

    if (!payeeId || !provider || !phoneNumber || !amountGmd) {
      return res.status(400).json({ error: 'payeeId, provider (afrimoney/qmoney), phoneNumber, and amountGmd are required' });
    }

    if (!['afrimoney', 'qmoney'].includes(provider.toLowerCase())) {
      return res.status(400).json({ error: 'Provider must be either "afrimoney" or "qmoney"' });
    }

    const tx = initiateEscrow({
      jobId,
      payerId: req.user.id,
      payeeId,
      provider: provider.toLowerCase(),
      phoneNumber,
      amountGmd: parseFloat(amountGmd)
    });

    logAuditEvent({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'MOMO_ESCROW_INITIATED',
      targetType: 'momo_transaction',
      targetId: tx.transactionId,
      details: { referenceCode: tx.referenceCode, provider, amountGmd }
    });

    res.status(201).json(tx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Confirm USSD Push by simulating handset PIN entry
 */
router.post('/escrow/confirm-ussd', (req, res) => {
  try {
    const { referenceCode, pin = '1234' } = req.body;

    if (!referenceCode) {
      return res.status(400).json({ error: 'referenceCode is required' });
    }

    const result = confirmUssdPush(referenceCode, pin);

    logAuditEvent({
      action: 'MOMO_ESCROW_CONFIRMED',
      targetType: 'momo_transaction',
      targetId: result.id,
      details: { referenceCode, status: result.status }
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Release Escrow payment to Workshop / Supplier upon signoff
 */
router.post('/escrow/release', authenticateToken, (req, res) => {
  try {
    const { referenceCode } = req.body;

    if (!referenceCode) {
      return res.status(400).json({ error: 'referenceCode is required' });
    }

    const result = releaseEscrow(referenceCode, req.user);

    logAuditEvent({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'MOMO_ESCROW_RELEASED',
      targetType: 'momo_transaction',
      targetId: referenceCode,
      details: { disbursedGmd: result.payeeAmountDisbursedGmd, status: result.status }
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Refund Escrow payment to customer wallet
 */
router.post('/escrow/refund', authenticateToken, (req, res) => {
  try {
    const { referenceCode, reason } = req.body;

    if (!referenceCode) {
      return res.status(400).json({ error: 'referenceCode is required' });
    }

    const result = refundEscrow(referenceCode, reason || 'Customer cancellation or dispute resolution');

    logAuditEvent({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'MOMO_ESCROW_REFUNDED',
      targetType: 'momo_transaction',
      targetId: referenceCode,
      details: { amount: result.refundedAmountGmd, reason: result.reason }
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * List all Mobile Money transactions
 */
router.get('/transactions', authenticateToken, (req, res) => {
  const { provider, status } = req.query;
  let sql = `
    SELECT t.*, 
           payer.name as payer_name, payer.phone as payer_phone,
           payee.name as payee_name, payee.phone as payee_phone
    FROM momo_escrow_transactions t
    LEFT JOIN users payer ON t.payer_id = payer.id
    LEFT JOIN users payee ON t.payee_id = payee.id
  `;
  const params = [];
  const clauses = [];

  // Filter by user role if not admin
  if (req.user.role !== 'admin') {
    clauses.push('(t.payer_id = ? OR t.payee_id = ?)');
    params.push(req.user.id, req.user.id);
  }

  if (provider) {
    clauses.push('t.provider = ?');
    params.push(provider);
  }

  if (status) {
    clauses.push('t.status = ?');
    params.push(status);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY t.created_at DESC';
  const transactions = query(sql, params);
  res.json({ transactions });
});

export default router;
