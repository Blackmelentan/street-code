import express from 'express';
import crypto from 'node:crypto';
import { query, queryOne, run } from '../db/database.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { appendPassportBlock } from '../services/passport.service.js';
import { logAuditEvent } from '../services/audit.service.js';
import { broadcastToClients } from '../server.js';

const router = express.Router();

/**
 * Log a Mandatory Procedural Police Roadside Search (GAP 5)
 * Requires officer identification, location checkpoint, justification, and findings.
 */
router.post('/search-log', authenticateToken, requireRole('police', 'admin'), (req, res) => {
  const { vehicle_vin, vehicle_plate, location_checkpoint, search_reason, search_findings, flagged_stolen = 0 } = req.body;

  if (!vehicle_plate || !location_checkpoint || !search_reason || !search_findings) {
    return res.status(400).json({
      error: 'vehicle_plate, location_checkpoint, search_reason, and search_findings are mandatory for roadside search logging'
    });
  }

  const id = `psl-${crypto.randomUUID().slice(0, 8)}`;
  const badge = req.user.badge_number || 'GPF-PATROL';

  run(
    `INSERT INTO police_search_logs 
      (id, officer_id, officer_badge, vehicle_vin, vehicle_plate, location_checkpoint, search_reason, search_findings, flagged_stolen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.user.id, badge, vehicle_vin || 'UNKNOWN', vehicle_plate.toUpperCase(), location_checkpoint, search_reason, search_findings, flagged_stolen ? 1 : 0]
  );

  logAuditEvent({
    actorId: req.user.id,
    actorRole: 'police',
    action: 'POLICE_ROADSIDE_SEARCH_LOGGED',
    targetType: 'vehicle_search',
    targetId: id,
    details: { plate: vehicle_plate, checkpoint: location_checkpoint, reason: search_reason, officerBadge: badge }
  });

  res.status(201).json({
    message: 'Mandatory procedural roadside search logged to national chain of custody',
    logId: id,
    officerBadge: badge,
    timestamp: new Date().toISOString()
  });
});

/**
 * Get all logged police roadside searches
 */
router.get('/search-logs', authenticateToken, requireRole('police', 'admin'), (req, res) => {
  const { plate } = req.query;
  let sql = `
    SELECT s.*, u.name as officer_name 
    FROM police_search_logs s 
    LEFT JOIN users u ON s.officer_id = u.id
  `;
  const params = [];

  if (plate) {
    sql += ' WHERE UPPER(s.vehicle_plate) = UPPER(?)';
    params.push(plate.trim());
  }

  sql += ' ORDER BY s.timestamp DESC LIMIT 100';
  const logs = query(sql, params);
  res.json({ logs });
});

/**
 * Broadcast Stolen Vehicle Alert (APB) across Civic & Mobile Networks
 */
router.post('/stolen-alert', authenticateToken, (req, res) => {
  const { vehicle_id, last_seen_location, details, alert_radius_km = 50 } = req.body;

  if (!vehicle_id || !last_seen_location || !details) {
    return res.status(400).json({ error: 'vehicle_id, last_seen_location, and details are required' });
  }

  const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [vehicle_id]);
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  // Update vehicle record
  const reportedAt = new Date().toISOString();
  run(
    `UPDATE vehicles 
     SET stolen_flag = 1, status = 'stolen', stolen_reported_at = ?, stolen_notes = ? 
     WHERE id = ?`,
    [reportedAt, details, vehicle.id]
  );

  const apbId = `apb-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO stolen_broadcasts (id, vehicle_id, reported_by, last_seen_location, details, status, alert_radius_km)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE_ALERT', ?)`,
    [apbId, vehicle.id, req.user.id, last_seen_location, details, alert_radius_km]
  );

  // Mint Stolen Report block in Passport
  appendPassportBlock({
    vehicleId: vehicle.id,
    eventType: 'STOLEN_REPORT',
    mileage: vehicle.current_mileage,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorName: req.user.name,
    description: `STOLEN ALERT: Vehicle reported missing from ${last_seen_location}. Active Police APB #${apbId}.`,
    dataPayload: { apbId, lastSeenLocation: last_seen_location, details }
  });

  // Broadcast Real-time WebSocket Alert to all Civic Stations and Patrolling Officers!
  broadcastToClients({
    type: 'STOLEN_VEHICLE_BROADCAST',
    alertId: apbId,
    vehicle: {
      id: vehicle.id,
      vin: vehicle.vin,
      plateNumber: vehicle.plate_number,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      color: vehicle.color
    },
    location: last_seen_location,
    details,
    timestamp: reportedAt
  });

  logAuditEvent({
    actorId: req.user.id,
    actorRole: req.user.role,
    action: 'STOLEN_VEHICLE_BROADCAST',
    targetType: 'vehicle',
    targetId: vehicle.id,
    details: { plate: vehicle.plate_number, apbId }
  });

  res.status(201).json({
    message: 'Stolen vehicle alert broadcast nationwide to all civic checkpoints and police patrol consoles',
    apbId,
    reportedAt
  });
});

/**
 * List Active Stolen Vehicle Alerts
 */
router.get('/stolen-alerts', (req, res) => {
  const alerts = query(`
    SELECT b.*, 
           v.vin, v.plate_number, v.make, v.model, v.year, v.color,
           u.name as reporter_name, u.phone as reporter_phone
    FROM stolen_broadcasts b
    JOIN vehicles v ON b.vehicle_id = v.id
    JOIN users u ON b.reported_by = u.id
    WHERE b.status = 'ACTIVE_ALERT'
    ORDER BY b.created_at DESC
  `);

  res.json({ alerts });
});

/**
 * Clear Stolen Alert upon Recovery
 */
router.post('/recover-stolen', authenticateToken, requireRole('police', 'admin'), (req, res) => {
  const { apbId, vehicleId, recoveryNotes } = req.body;

  const vehicle = queryOne('SELECT * FROM vehicles WHERE id = ?', [vehicleId]);
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found' });
  }

  run(
    `UPDATE vehicles 
     SET stolen_flag = 0, status = 'active', stolen_notes = NULL 
     WHERE id = ?`,
    [vehicle.id]
  );

  if (apbId) {
    run(`UPDATE stolen_broadcasts SET status = 'RECOVERED' WHERE id = ?`, [apbId]);
  }

  // Mint Recovery Block
  appendPassportBlock({
    vehicleId: vehicle.id,
    eventType: 'STOLEN_RECOVERED',
    mileage: vehicle.current_mileage,
    actorId: req.user.id,
    actorRole: 'police',
    actorName: req.user.name,
    description: `Vehicle recovered and inspected by ${req.user.name} (${req.user.badge_number || 'GPF'}). Flag cleared.`,
    dataPayload: { recoveryNotes: recoveryNotes || 'Normal condition confirmed upon impound release.' }
  });

  broadcastToClients({
    type: 'STOLEN_VEHICLE_RECOVERED',
    vehicleId: vehicle.id,
    plateNumber: vehicle.plate_number,
    message: `Vehicle ${vehicle.plate_number} has been safely recovered.`
  });

  res.json({ message: 'Vehicle marked recovered, passport sealed, alert cleared.' });
});

export default router;
