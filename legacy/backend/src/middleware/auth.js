import jwt from 'jsonwebtoken';
import { queryOne } from '../db/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'streetcode_dev_jwt_secret_2026_secured';

/**
 * Generate a signed JWT token for an authenticated user
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      phone: user.phone,
      role: user.role,
      name: user.name,
      badgeNumber: user.badge_number || null,
      organization: user.organization || null
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Express middleware to authenticate Bearer token
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. No Bearer token provided.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }

    const user = queryOne('SELECT id, name, phone, email, role, kyc_status, badge_number, organization FROM users WHERE id = ?', [decoded.id]);
    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists.' });
    }

    req.user = user;
    next();
  });
}

/**
 * Role-based authorization middleware
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'admin') {
      return res.status(403).json({
        error: `Access denied. Requires one of roles: [${allowedRoles.join(', ')}]. Current role: '${req.user.role}'`
      });
    }

    next();
  };
}
