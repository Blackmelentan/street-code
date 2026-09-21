import crypto from 'node:crypto';
import { queryOne, run } from '../db/database.js';
import { appendPassportBlock } from './passport.service.js';

const PLATFORM_FEE_PERCENT = 0.025; // 2.5% platform fee

/**
 * Validate phone number format for Gambian telecom operators
 */
export function validateMoMoPhone(provider, phone) {
  const cleanPhone = phone.replace(/[\s\-]/g, '');
  // Gambian numbers start with +220 or 220, followed by 7 digits
  // Africell (Afrimoney): 7xxxxxx, 2xxxxxx
  // QCell (QMoney): 3xxxxxx, 5xxxxxx
  const momoPattern = /^(\+?220)?[23579]\d{6}$/;
  if (!momoPattern.test(cleanPhone)) {
    return { valid: false, reason: 'Invalid Gambian mobile number format. Expected e.g. +220 7xxxxxx or +220 3xxxxxx' };
  }
  return { valid: true, normalized: cleanPhone.startsWith('+') ? cleanPhone : `+220${cleanPhone.replace(/^220/, '')}` };
}

/**
 * Initiate a Mobile Money Escrow Hold (USSD Push sent to customer handset)
 */
export function initiateEscrow({ jobId, payerId, payeeId, provider, phoneNumber, amountGmd }) {
  const phoneValidation = validateMoMoPhone(provider, phoneNumber);
  if (!phoneValidation.valid) {
    throw new Error(phoneValidation.reason);
  }

  const id = crypto.randomUUID();
  const referenceCode = `SC-MM-${provider.toUpperCase().slice(0, 3)}-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const platformFee = Math.round(amountGmd * PLATFORM_FEE_PERCENT * 100) / 100;
  const netAmount = Math.round((amountGmd - platformFee) * 100) / 100;

  run(
    `INSERT INTO momo_escrow_transactions 
      (id, job_id, payer_id, payee_id, provider, phone_number, amount_gmd, platform_fee_gmd, net_amount_gmd, reference_code, status, ussd_prompt_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_ussd', 'SENT')`,
    [id, jobId || null, payerId, payeeId, provider, phoneValidation.normalized, amountGmd, platformFee, netAmount, referenceCode]
  );

  return {
    transactionId: id,
    referenceCode,
    provider,
    phoneNumber: phoneValidation.normalized,
    amountGmd,
    platformFeeGmd: platformFee,
    netAmountGmd: netAmount,
    status: 'pending_ussd',
    ussdPrompt: provider === 'afrimoney' 
      ? `Afrimoney USSD: Approve D${amountGmd} escrow for Street Code job ${referenceCode}. Enter PIN on handset (*777#):`
      : `QMoney USSD: Authorize payment D${amountGmd} to Street Code Escrow. Dial *323# or approve push prompt with PIN:`
  };
}

/**
 * Simulate USSD PIN submission & mobile network webhook callback
 */
export function confirmUssdPush(referenceCode, pin = '1234') {
  const tx = queryOne('SELECT * FROM momo_escrow_transactions WHERE reference_code = ?', [referenceCode]);
  if (!tx) {
    throw new Error(`Transaction ${referenceCode} not found`);
  }

  if (tx.status !== 'pending_ussd') {
    throw new Error(`Transaction is already in status '${tx.status}'`);
  }

  // Update status to held_in_escrow
  run(
    `UPDATE momo_escrow_transactions 
     SET status = 'held_in_escrow', ussd_prompt_status = 'CONFIRMED' 
     WHERE id = ?`,
    [tx.id]
  );

  // If tied to a job card, update the job card status to escrow_funded
  if (tx.job_id) {
    run(
      `UPDATE job_cards SET status = 'escrow_funded', escrow_tx_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [tx.id, tx.job_id]
    );
  }

  return {
    ...tx,
    status: 'held_in_escrow',
    ussd_prompt_status: 'CONFIRMED',
    message: `Funds safely locked in Street Code Escrow (D${tx.amount_gmd}). Workshop is authorized to begin work.`
  };
}

/**
 * Release Escrow to Mechanic/Supplier upon work verification
 */
export function releaseEscrow(referenceCode, actorUser) {
  const tx = queryOne('SELECT * FROM momo_escrow_transactions WHERE reference_code = ?', [referenceCode]);
  if (!tx) {
    throw new Error(`Transaction ${referenceCode} not found`);
  }

  if (tx.status !== 'held_in_escrow') {
    throw new Error(`Cannot release funds: Transaction status is '${tx.status}', expected 'held_in_escrow'`);
  }

  const releasedAt = new Date().toISOString();
  run(
    `UPDATE momo_escrow_transactions 
     SET status = 'released', escrow_released_at = ? 
     WHERE id = ?`,
    [releasedAt, tx.id]
  );

  // If tied to a job card, close job card and write cryptographic passport block
  let passportBlock = null;
  if (tx.job_id) {
    const job = queryOne('SELECT * FROM job_cards WHERE id = ?', [tx.job_id]);
    if (job) {
      run(`UPDATE job_cards SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [job.id]);
      
      const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [job.vehicle_id]);
      if (vehicle) {
        passportBlock = appendPassportBlock({
          vehicleId: vehicle.id,
          eventType: 'MAJOR_REPAIR',
          mileage: vehicle.current_mileage,
          actorId: actorUser.id,
          actorRole: actorUser.role,
          actorName: actorUser.name,
          description: `Work order completed and verified. D${tx.amount_gmd} released via ${tx.provider.toUpperCase()} Escrow.`,
          dataPayload: {
            jobId: job.id,
            complaint: job.complaint,
            laborCost: job.labor_cost,
            partsCost: job.parts_cost,
            totalCost: job.total_cost,
            escrowRef: referenceCode,
            paidVia: tx.provider
          }
        });
      }
    }
  }

  return {
    referenceCode,
    status: 'released',
    payeeAmountDisbursedGmd: tx.net_amount_gmd,
    platformFeeRetainedGmd: tx.platform_fee_gmd,
    releasedAt,
    passportBlock
  };
}

/**
 * Refund Escrow back to customer wallet
 */
export function refundEscrow(referenceCode, reason) {
  const tx = queryOne('SELECT * FROM momo_escrow_transactions WHERE reference_code = ?', [referenceCode]);
  if (!tx) {
    throw new Error(`Transaction ${referenceCode} not found`);
  }

  if (tx.status !== 'held_in_escrow' && tx.status !== 'disputed') {
    throw new Error(`Cannot refund: Transaction status is '${tx.status}'`);
  }

  run(`UPDATE momo_escrow_transactions SET status = 'refunded' WHERE id = ?`, [tx.id]);

  if (tx.job_id) {
    run(`UPDATE job_cards SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [tx.job_id]);
  }

  return {
    referenceCode,
    status: 'refunded',
    refundedAmountGmd: tx.amount_gmd,
    reason
  };
}
