import express from 'express';
import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.service.js';

const router = express.Router();

/**
 * List all workshops with live bay capacity
 */
router.get('/', (req, res) => {
  const workshops = query('SELECT * FROM workshops ORDER BY rating DESC').map(w => ({
    ...w,
    specialties: (() => {
      try { return JSON.parse(w.specialties); } catch { return []; }
    })(),
    available_bays: Math.max(0, w.active_bays - w.occupied_bays),
    capacity_percentage: Math.round((w.occupied_bays / w.active_bays) * 100)
  }));

  res.json({ workshops });
});

/**
 * Get workshop by ID
 */
router.get('/:id', (req, res) => {
  const w = queryOne('SELECT * FROM workshops WHERE id = ?', [req.params.id]);
  if (!w) {
    return res.status(404).json({ error: 'Workshop not found' });
  }

  res.json({
    workshop: {
      ...w,
      specialties: (() => {
        try { return JSON.parse(w.specialties); } catch { return []; }
      })(),
      available_bays: Math.max(0, w.active_bays - w.occupied_bays)
    }
  });
});

/**
 * List Job Cards
 */
router.get('/jobs/all', authenticateToken, (req, res) => {
  const { status, vehicle_id } = req.query;
  let sql = `
    SELECT j.*, 
           v.vin, v.plate_number, v.make, v.model, v.year,
           c.name as customer_name, c.phone as customer_phone,
           m.name as mechanic_name,
           w.name as workshop_name
    FROM job_cards j
    LEFT JOIN vehicles v ON j.vehicle_id = v.id
    LEFT JOIN users c ON j.customer_id = c.id
    LEFT JOIN users m ON j.mechanic_id = m.id
    LEFT JOIN workshops w ON j.workshop_id = w.id
  `;
  const params = [];
  const clauses = [];

  if (status) {
    clauses.push('j.status = ?');
    params.push(status);
  }
  if (vehicle_id) {
    clauses.push('j.vehicle_id = ?');
    params.push(vehicle_id);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY j.updated_at DESC';
  const jobs = query(sql, params).map(j => ({
    ...j,
    diagnostic_dtcs: (() => {
      try { return JSON.parse(j.diagnostic_dtcs); } catch { return []; }
    })(),
    parts_required: (() => {
      try { return JSON.parse(j.parts_required); } catch { return []; }
    })()
  }));

  res.json({ jobs });
});

/**
 * Create a new Job Card
 */
router.post('/jobs', authenticateToken, (req, res) => {
  const { vehicle_id, mechanic_id, workshop_id, complaint, diagnostic_dtcs = [], parts_required = [], labor_cost = 0, parts_cost = 0 } = req.body;

  if (!vehicle_id || !complaint) {
    return res.status(400).json({ error: 'vehicle_id and complaint are required' });
  }

  const id = `job-${crypto.randomUUID().slice(0, 8)}`;
  const totalCost = parseFloat(labor_cost) + parseFloat(parts_cost);

  run(
    `INSERT INTO job_cards 
      (id, vehicle_id, customer_id, mechanic_id, workshop_id, status, complaint, diagnostic_dtcs, parts_required, labor_cost, parts_cost, total_cost)
     VALUES (?, ?, ?, ?, ?, 'quoted', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      vehicle_id,
      req.user.id,
      mechanic_id || 'usr-mech-01',
      workshop_id || 'ws-kairaba-01',
      complaint,
      JSON.stringify(diagnostic_dtcs),
      JSON.stringify(parts_required),
      labor_cost,
      parts_cost,
      totalCost
    ]
  );

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'JOB_CARD_CREATED',
    targetType: 'job_card',
    targetId: id,
    details: { complaint, totalCost }
  });

  res.status(201).json({
    message: 'Job card opened and quoted',
    jobId: id,
    totalCost
  });
});

/**
 * Update Job Card Status
 */
router.patch('/jobs/:id', authenticateToken, (req, res) => {
  const { status, labor_cost, parts_cost } = req.body;
  const job = queryOne('SELECT * FROM job_cards WHERE id = ?', [req.params.id]);

  if (!job) {
    return res.status(404).json({ error: 'Job card not found' });
  }

  let totalCost = job.total_cost;
  if (labor_cost !== undefined || parts_cost !== undefined) {
    const l = labor_cost !== undefined ? parseFloat(labor_cost) : job.labor_cost;
    const p = parts_cost !== undefined ? parseFloat(parts_cost) : job.parts_cost;
    totalCost = l + p;
  }

  run(
    `UPDATE job_cards 
     SET status = COALESCE(?, status), 
         labor_cost = COALESCE(?, labor_cost),
         parts_cost = COALESCE(?, parts_cost),
         total_cost = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status || null, labor_cost !== undefined ? labor_cost : null, parts_cost !== undefined ? parts_cost : null, totalCost, job.id]
  );

  res.json({ message: 'Job card updated', jobId: job.id, status: status || job.status });
});

/**
 * List Parts Catalog
 */
router.get('/parts/all', (req, res) => {
  const { category, search } = req.query;
  let sql = 'SELECT * FROM parts_inventory';
  const params = [];
  const clauses = [];

  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (search) {
    clauses.push('(name LIKE ? OR part_number LIKE ? OR compatible_models LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY name ASC';
  const parts = query(sql, params);
  res.json({ parts });
});

export default router;
