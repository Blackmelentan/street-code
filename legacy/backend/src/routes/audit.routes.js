import express from 'express';
import { query, queryOne } from '../db/database.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { getAuditLogs } from '../services/audit.service.js';

const router = express.Router();

/**
 * Get immutable platform audit logs (Civic Oversight & Compliance)
 */
router.get('/logs', authenticateToken, requireRole('admin', 'police'), (req, res) => {
  const { action, targetType, limit = 50 } = req.query;
  const logs = getAuditLogs({ action, targetType, limit: parseInt(limit, 10) });
  res.json({ logs });
});

/**
 * Get aggregate civic & platform metrics
 */
router.get('/metrics/summary', (req, res) => {
  const totalVehicles = queryOne('SELECT COUNT(*) as count FROM vehicles').count;
  const stolenVehicles = queryOne('SELECT COUNT(*) as count FROM vehicles WHERE stolen_flag = 1').count;
  const totalPassportBlocks = queryOne('SELECT COUNT(*) as count FROM passport_blocks').count;
  const totalWorkshops = queryOne('SELECT COUNT(*) as count FROM workshops').count;
  const activeBays = queryOne('SELECT SUM(active_bays) as total, SUM(occupied_bays) as occupied FROM workshops');
  const momoVolume = queryOne("SELECT SUM(amount_gmd) as volume, COUNT(*) as count FROM momo_escrow_transactions WHERE status IN ('held_in_escrow', 'released')");
  const citationsSummary = queryOne(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'waived_via_course' THEN 1 ELSE 0 END) as waived,
           SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
           SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as open
    FROM citations
  `);

  res.json({
    metrics: {
      registeredVehicles: totalVehicles,
      stolenAlertsActive: stolenVehicles,
      cryptographicPassportBlocks: totalPassportBlocks,
      certifiedWorkshops: totalWorkshops,
      workshopBays: {
        total: activeBays.total || 0,
        occupied: activeBays.occupied || 0,
        available: (activeBays.total || 0) - (activeBays.occupied || 0)
      },
      momoEscrow: {
        volumeGmd: momoVolume.volume || 0,
        transactionsCount: momoVolume.count || 0
      },
      citations: {
        total: citationsSummary.total || 0,
        waivedViaEducation: citationsSummary.waived || 0,
        paid: citationsSummary.paid || 0,
        open: citationsSummary.open || 0
      }
    }
  });
});

export default router;
