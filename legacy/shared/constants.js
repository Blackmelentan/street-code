/**
 * Street Code Shared Constants & Domain Enums
 * Used across Backend, Web, Civic, and Mobile clients
 */

export const ROLES = {
  OWNER: 'owner',
  MECHANIC: 'mechanic',
  DRIVER: 'driver',
  FLEET_OPERATOR: 'fleet_operator',
  POLICE: 'police',
  ADMIN: 'admin'
};

export const VEHICLE_STATUS = {
  ACTIVE: 'active',
  IN_MAINTENANCE: 'in_maintenance',
  IMPOUNDED: 'impounded',
  STOLEN: 'stolen',
  INSPECTION_DUE: 'inspection_due',
  OFFLINE: 'offline'
};

export const PASSPORT_EVENT_TYPES = {
  GENESIS: 'GENESIS',
  OWNERSHIP_TRANSFER: 'OWNERSHIP_TRANSFER',
  ROUTINE_SERVICE: 'ROUTINE_SERVICE',
  MAJOR_REPAIR: 'MAJOR_REPAIR',
  OBD_DIAGNOSTIC: 'OBD_DIAGNOSTIC',
  ROADWORTHINESS_TEST: 'ROADWORTHINESS_TEST',
  POLICE_CLEARANCE: 'POLICE_CLEARANCE',
  STOLEN_REPORT: 'STOLEN_REPORT',
  STOLEN_RECOVERED: 'STOLEN_RECOVERED'
};

export const MOMO_PROVIDERS = {
  AFRIMONEY: 'afrimoney',
  QMONEY: 'qmoney'
};

export const ESCROW_STATUS = {
  PENDING_USSD: 'pending_ussd',
  HELD_IN_ESCROW: 'held_in_escrow',
  RELEASED: 'released',
  REFUNDED: 'refunded',
  DISPUTED: 'disputed'
};

export const CITATION_STATUS = {
  ISSUED: 'issued',
  PAID: 'paid',
  WAIVED_VIA_COURSE: 'waived_via_course',
  CONTESTED: 'contested'
};

export const POLICE_SEARCH_REASONS = [
  'Routine Checkpoint Inspection',
  'Suspected Stolen Vehicle Match',
  'Expired Road Tax / Insurance',
  'Safety Violation / Defective Lighting',
  'Amber Alert / Civic APB Notification'
];

export const COMMON_DTC_CODES = {
  'P0300': { description: 'Random/Multiple Cylinder Misfire Detected', severity: 'HIGH', category: 'Engine' },
  'P0420': { description: 'Catalyst System Efficiency Below Threshold (Bank 1)', severity: 'MEDIUM', category: 'Emissions' },
  'P0171': { description: 'System Too Lean (Bank 1)', severity: 'MEDIUM', category: 'Fuel/Air' },
  'P0128': { description: 'Coolant Thermostat Below Regulating Temperature', severity: 'LOW', category: 'Cooling' },
  'P0442': { description: 'Evaporative Emission Control System Leak Detected (Small)', severity: 'LOW', category: 'Emissions' },
  'P0700': { description: 'Transmission Control System Malfunction', severity: 'HIGH', category: 'Transmission' }
};
