/** Shared domain constants. Kept dependency-free so browsers can import them too. */

export const PLATFORM_ROLES = { USER: 'user', ADMIN: 'admin' };

/** Organisation types a person can belong to. */
export const ORG_TYPES = { GARAGE: 'garage', FLEET: 'fleet', STATION: 'station', CARWASH: 'carwash' };

/** Roles inside an organisation. Higher rank can manage lower rank. */
export const ORG_ROLES = {
  owner:      { rank: 100, label: 'Owner' },
  manager:    { rank: 80,  label: 'Manager' },
  supervisor: { rank: 70,  label: 'Supervisor' },
  mechanic:   { rank: 50,  label: 'Mechanic' },
  attendant:  { rank: 40,  label: 'Attendant' },
  officer:    { rank: 30,  label: 'Officer' },
  driver:     { rank: 20,  label: 'Driver' },
};

export const ROLES_BY_ORG = {
  garage:  ['owner', 'manager', 'mechanic', 'attendant'],
  carwash: ['owner', 'manager', 'attendant'],
  fleet:   ['owner', 'manager', 'driver'],
  station: ['owner', 'supervisor', 'officer'],
};

export const EMPLOYMENT = ['owner', 'employee', 'contractor'];

/** Flags: what the police can put on a vehicle or a person. */
export const FLAG_KINDS = {
  stolen:              { label: 'Stolen vehicle',       subject: 'vehicle', defaultLevel: 'red',   needsApproval: false },
  unauthorized_use:    { label: 'Unauthorised use',     subject: 'vehicle', defaultLevel: 'red',   needsApproval: false },
  vehicle_of_interest: { label: 'Vehicle of interest',  subject: 'vehicle', defaultLevel: 'amber', needsApproval: false },
  amber:               { label: 'Amber alert',          subject: 'vehicle', defaultLevel: 'amber', needsApproval: true },
  wanted:              { label: 'Wanted person',        subject: 'person',  defaultLevel: 'red',   needsApproval: true },
  person_of_interest:  { label: 'Person of interest',   subject: 'person',  defaultLevel: 'amber', needsApproval: true },
};

export const FLAG_INSTRUCTIONS = {
  observe:        'Observe and report. Do not approach.',
  call_dispatch:  'Call dispatch before any contact.',
  detain:         'Detain and secure the vehicle.',
  do_not_approach:'Do not approach. Armed or dangerous.',
  verify_owner:   'Verify the driver is authorised by the owner.',
};

export const CHECK_REASONS = [
  'Routine checkpoint',
  'Suspected stolen vehicle',
  'Expired documents',
  'Safety or lighting defect',
  'Traffic offence',
  'Active alert or APB',
  'Accident scene',
];

export const CHECK_OUTCOMES = ['clear', 'advisory', 'action_required', 'flag_hit'];

export const JOB_STATUS = ['requested', 'quoted', 'accepted', 'in_progress', 'ready', 'completed', 'cancelled'];

export const MAX_ODOMETER_JUMP_PER_DAY = 1500; // km/day: above this a reading is treated as suspicious
