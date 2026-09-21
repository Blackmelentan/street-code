import express from 'express';
import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { appendPassportBlock, getPassportBlocks, verifyPassportChain } from '../services/passport.service.js';
import { logAuditEvent } from '../services/audit.service.js';

const router = express.Router();

/**
 * List vehicles (with optional status or owner filter)
 */
router.get('/', (req, res) => {
  const { owner_id, status } = req.query;
  let sql = `
    SELECT v.*, u.name as owner_name, u.phone as owner_phone 
    FROM vehicles v 
    LEFT JOIN users u ON v.owner_id = u.id
  `;
  const params = [];
  const clauses = [];

  if (owner_id) {
    clauses.push('v.owner_id = ?');
    params.push(owner_id);
  }
  if (status) {
    clauses.push('v.status = ?');
    params.push(status);
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  sql += ' ORDER BY v.created_at DESC';
  const vehicles = query(sql, params);
  res.json({ vehicles });
});

/**
 * Public Vehicle Lookup by VIN or License Plate Number
 * Essential for Web Portal, Police Roadside checks, and Used Car Buyers
 */
router.get('/lookup', (req, res) => {
  const { vin, plate } = req.query;

  if (!vin && !plate) {
    return res.status(400).json({ error: 'Please provide either ?vin=... or ?plate=... parameter' });
  }

  let vehicle = null;
  if (vin) {
    vehicle = queryOne(
      `SELECT v.*, u.name as owner_name, u.phone as owner_phone 
       FROM vehicles v 
       LEFT JOIN users u ON v.owner_id = u.id 
       WHERE UPPER(v.vin) = UPPER(?)`,
      [vin.trim()]
    );
  } else if (plate) {
    vehicle = queryOne(
      `SELECT v.*, u.name as owner_name, u.phone as owner_phone 
       FROM vehicles v 
       LEFT JOIN users u ON v.owner_id = u.id 
       WHERE UPPER(REPLACE(v.plate_number, '-', '')) = UPPER(REPLACE(?, '-', ''))`,
      [plate.trim()]
    );
  }

  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found in National Street Code Registry' });
  }

  // Get cryptographic passport summary & integrity verification
  const verification = verifyPassportChain(vehicle.id);
  const blocks = getPassportBlocks(vehicle.id).map(b => ({
    ...b,
    data_payload: (() => {
      try { return JSON.parse(b.data_payload); } catch { return b.data_payload; }
    })()
  }));

  // Check if active citation exists
  const citations = query("SELECT * FROM citations WHERE vehicle_id = ? AND status = 'issued'", [vehicle.id]);

  res.json({
    vehicle,
    passportVerification: verification,
    blocksCount: blocks.length,
    historyBlocks: blocks,
    activeCitations: citations
  });
});

/**
 * Get vehicle by ID
 */
router.get('/:id', (req, res) => {
  const vehicle = queryOne(
    `SELECT v.*, u.name as owner_name, u.phone as owner_phone 
     FROM vehicles v 
     LEFT JOIN users u ON v.owner_id = u.id 
     WHERE v.id = ?`,
    [req.params.id]
  );

  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  res.json({ vehicle });
});

/**
 * Register a new vehicle
 */
router.post('/', authenticateToken, (req, res) => {
  const { vin, plate_number, make, model, year, color, mileage = 0 } = req.body;

  if (!vin || !plate_number || !make || !model || !year) {
    return res.status(400).json({ error: 'VIN, plate_number, make, model, and year are required' });
  }

  const existingVin = queryOne('SELECT id FROM vehicles WHERE vin = ?', [vin.toUpperCase()]);
  if (existingVin) {
    return res.status(409).json({ error: 'Vehicle with this VIN already registered' });
  }

  const existingPlate = queryOne('SELECT id FROM vehicles WHERE plate_number = ?', [plate_number.toUpperCase()]);
  if (existingPlate) {
    return res.status(409).json({ error: 'Vehicle with this plate number already registered' });
  }

  const id = `veh-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO vehicles (id, vin, plate_number, make, model, year, color, owner_id, status, current_mileage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [id, vin.toUpperCase(), plate_number.toUpperCase(), make, model, parseInt(year, 10), color || 'Unknown', req.user.id, parseInt(mileage, 10)]
  );

  // Mint Genesis Block in Cryptographic Passport
  const genesisBlock = appendPassportBlock({
    vehicleId: id,
    eventType: 'GENESIS',
    mileage: parseInt(mileage, 10),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorName: req.user.name,
    description: 'Vehicle Genesis Registration on Street Code OS',
    dataPayload: {
      initialOwner: req.user.name,
      registrationAuthority: 'Street Code Ministry of Transport Node'
    }
  });

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'VEHICLE_REGISTERED',
    targetType: 'vehicle',
    targetId: id,
    details: { vin, plate_number, make, model }
  });

  res.status(201).json({
    message: 'Vehicle registered with cryptographic genesis block minted',
    vehicleId: id,
    genesisBlock
  });
});

/**
 * Get Cryptographic Passport with mathematically verified provenance
 */
router.get('/:id/passport', (req, res) => {
  const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  const verification = verifyPassportChain(vehicle.id);
  const rawBlocks = getPassportBlocks(vehicle.id);
  const blocks = rawBlocks.map(b => ({
    ...b,
    data_payload: (() => {
      try { return JSON.parse(b.data_payload); } catch { return b.data_payload; }
    })()
  }));

  res.json({
    vehicleId: vehicle.id,
    vin: vehicle.vin,
    plateNumber: vehicle.plate_number,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    currentMileage: vehicle.current_mileage,
    stolenFlag: vehicle.stolen_flag === 1,
    verification,
    blocks
  });
});

/**
 * Append verified event block to Vehicle Passport
 */
router.post('/:id/passport', authenticateToken, (req, res) => {
  const { eventType, mileage, description, dataPayload = {} } = req.body;

  const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  if (!eventType || mileage === undefined || !description) {
    return res.status(400).json({ error: 'eventType, mileage, and description are required' });
  }

  // Mileage must not roll backwards
  if (parseInt(mileage, 10) < vehicle.current_mileage) {
    return res.status(400).json({
      error: `Odometer rollback detected! Reported mileage (${mileage} km) is less than recorded verified mileage (${vehicle.current_mileage} km).`
    });
  }

  const newBlock = appendPassportBlock({
    vehicleId: vehicle.id,
    eventType,
    mileage: parseInt(mileage, 10),
    actorId: req.user.id,
    actorRole: req.user.role,
    actorName: req.user.name,
    description,
    dataPayload
  });

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'PASSPORT_BLOCK_APPENDED',
    targetType: 'vehicle_passport',
    targetId: vehicle.id,
    details: { blockIndex: newBlock.block_index, eventType, hash: newBlock.current_hash }
  });

  res.status(201).json({
    message: 'Block successfully cryptographically sealed and chained to vehicle passport',
    block: newBlock
  });
});

export default router;
