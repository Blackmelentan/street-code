import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { queryOne, run } from '../db/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.service.js';

const router = express.Router();

/**
 * Login user via phone and password
 */
router.post('/login', (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required' });
  }

  // Clean phone string
  const cleanPhone = phone.replace(/[\s\-]/g, '');
  const user = queryOne('SELECT * FROM users WHERE phone = ? OR phone = ?', [cleanPhone, `+220${cleanPhone.replace(/^(\+?220)/, '')}`]);

  if (!user) {
    return res.status(401).json({ error: 'Invalid phone number or credentials' });
  }

  const isMatch = bcrypt.compareSync(password, user.password_hash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid phone number or credentials' });
  }

  const token = generateToken(user);

  logAuditEvent({
    actorId: user.id,
    actorRole: user.role,
    action: 'USER_LOGIN',
    targetType: 'user',
    targetId: user.id,
    details: { name: user.name, role: user.role }
  });

  const { password_hash, ...safeUser } = user;
  res.json({
    token,
    user: safeUser
  });
});

/**
 * Register new user
 */
router.post('/register', (req, res) => {
  const { name, phone, email, password, role = 'owner', organization, badgeNumber } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, phone, and password are required' });
  }

  const existing = queryOne('SELECT id FROM users WHERE phone = ?', [phone]);
  if (existing) {
    return res.status(409).json({ error: 'A user with this phone number already exists' });
  }

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);

  run(
    `INSERT INTO users (id, name, phone, email, password_hash, role, kyc_status, badge_number, organization)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
    [id, name, phone, email || null, passwordHash, role, badgeNumber || null, organization || null]
  );

  const newUser = queryOne('SELECT id, name, phone, email, role, kyc_status, badge_number, organization FROM users WHERE id = ?', [id]);
  const token = generateToken(newUser);

  logAuditEvent({
    actorId: newUser.id,
    actorRole: newUser.role,
    action: 'USER_REGISTER',
    targetType: 'user',
    targetId: newUser.id,
    details: { name, role }
  });

  res.status(201).json({
    token,
    user: newUser
  });
});

/**
 * Get current authenticated user profile
 */
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

export default router;
