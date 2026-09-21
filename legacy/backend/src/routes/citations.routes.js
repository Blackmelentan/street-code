import express from 'express';
import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.service.js';
import { appendPassportBlock } from '../services/passport.service.js';

const router = express.Router();

/**
 * List citations (filtered by driver or vehicle)
 */
router.get('/', authenticateToken, (req, res) => {
  const { driver_id, vehicle_id, status } = req.query;
  let sql = `
    SELECT c.*, 
           v.plate_number, v.make, v.model, v.vin,
           d.name as driver_name, d.phone as driver_phone,
           o.name as officer_name, o.badge_number as officer_badge
    FROM citations c
    JOIN vehicles v ON c.vehicle_id = v.id
    JOIN users d ON c.driver_id = d.id
    JOIN users o ON c.officer_id = o.id
  `;
  const params = [];
  const clauses = [];

  // Commercial drivers or vehicle owners can see their own citations
  if (req.user.role === 'driver' || req.user.role === 'owner') {
    clauses.push('(c.driver_id = ? OR v.owner_id = ?)');
    params.push(req.user.id, req.user.id);
  } else if (driver_id) {
    clauses.push('c.driver_id = ?');
    params.push(driver_id);
  }

  if (vehicle_id) {
    clauses.push('c.vehicle_id = ?');
    params.push(vehicle_id);
  }

  if (status) {
    clauses.push('c.status = ?');
    params.push(status);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY c.created_at DESC';
  const citations = query(sql, params);
  res.json({ citations });
});

/**
 * Issue a traffic citation (Police only)
 */
router.post('/', authenticateToken, requireRole('police', 'admin'), (req, res) => {
  const { vehicle_id, driver_id, violation_code, violation_title, fine_amount_gmd, eligible_for_waiver = 1 } = req.body;

  if (!vehicle_id || !driver_id || !violation_code || !violation_title || !fine_amount_gmd) {
    return res.status(400).json({ error: 'vehicle_id, driver_id, violation_code, violation_title, and fine_amount_gmd are required' });
  }

  const id = `cit-${crypto.randomUUID().slice(0, 8)}`;
  const citationNumber = `CIT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  run(
    `INSERT INTO citations 
      (id, citation_number, vehicle_id, driver_id, officer_id, violation_code, violation_title, fine_amount_gmd, eligible_for_waiver, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
    [id, citationNumber, vehicle_id, driver_id, req.user.id, violation_code, violation_title, fine_amount_gmd, eligible_for_waiver ? 1 : 0]
  );

  logAuditEvent({
    actorId: req.user.id,
    actorRole: 'police',
    action: 'CITATION_ISSUED',
    targetType: 'citation',
    targetId: id,
    details: { citationNumber, violationCode: violation_code, fineGmd: fine_amount_gmd }
  });

  res.status(201).json({
    message: 'Citation issued successfully',
    citationId: id,
    citationNumber,
    fineAmountGmd: fine_amount_gmd,
    eligibleForWaiver: Boolean(eligible_for_waiver)
  });
});

/**
 * In-App Driver Education Citation Waiver (GAP 6)
 * Drivers complete an educational traffic safety module to have eligible first-time fines waived.
 */
router.post('/:id/waive', authenticateToken, (req, res) => {
  const citation = queryOne('SELECT * FROM citations WHERE id = ?', [req.params.id]);

  if (!citation) {
    return res.status(404).json({ error: 'Citation not found' });
  }

  if (citation.status !== 'issued') {
    return res.status(400).json({ error: `Citation is already in '${citation.status}' status and cannot be waived.` });
  }

  if (!citation.eligible_for_waiver) {
    return res.status(400).json({ error: 'This violation is not eligible for the Driver Education Waiver program.' });
  }

  const { quizScore, courseModuleId } = req.body;
  if (quizScore !== undefined && quizScore < 80) {
    return res.status(400).json({
      error: `Quiz score of ${quizScore}% is below the 80% passing threshold for citation dismissal. Please review the module and retry.`
    });
  }

  const completedAt = new Date().toISOString();

  // Waive fine
  run(
    `UPDATE citations 
     SET status = 'waived_via_course', course_completed = 1, course_completed_at = ? 
     WHERE id = ?`,
    [completedAt, citation.id]
  );

  // Mint Educational Waiver into vehicle passport
  const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [citation.vehicle_id]);
  if (vehicle) {
    appendPassportBlock({
      vehicleId: vehicle.id,
      eventType: 'ROADWORTHINESS_TEST',
      mileage: vehicle.current_mileage,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.name,
      description: `Civic Traffic Citation #${citation.citation_number} waived upon certified completion of the Gambia Driver Safety Educational Curriculum.`,
      dataPayload: {
        citationNumber: citation.citation_number,
        originalViolation: citation.violation_title,
        fineWaivedGmd: citation.fine_amount_gmd,
        courseModule: courseModuleId || 'DEFENSIVE_DRIVING_AND_VEHICLE_LIGHTING_V1',
        quizScore: quizScore || 100
      }
    });
  }

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'CITATION_WAIVED_VIA_COURSE',
    targetType: 'citation',
    targetId: citation.id,
    details: { citationNumber: citation.citation_number, fineWaivedGmd: citation.fine_amount_gmd }
  });

  res.json({
    message: 'Congratulations! Driver education module successfully completed. Fine has been 100% waived.',
    citationNumber: citation.citation_number,
    fineWaivedGmd: citation.fine_amount_gmd,
    status: 'waived_via_course',
    completedAt
  });
});

/**
 * Pay Citation Fine directly
 */
router.post('/:id/pay', authenticateToken, (req, res) => {
  const citation = queryOne('SELECT * FROM citations WHERE id = ?', [req.params.id]);

  if (!citation) {
    return res.status(404).json({ error: 'Citation not found' });
  }

  if (citation.status !== 'issued') {
    return res.status(400).json({ error: `Citation is already in '${citation.status}' status.` });
  }

  run(`UPDATE citations SET status = 'paid' WHERE id = ?`, [citation.id]);

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'CITATION_PAID',
    targetType: 'citation',
    targetId: citation.id,
    details: { citationNumber: citation.citation_number, amountGmd: citation.fine_amount_gmd }
  });

  res.json({
    message: `Payment of D${citation.fine_amount_gmd} received. Citation settled.`,
    citationNumber: citation.citation_number,
    status: 'paid'
  });
});

export default router;
