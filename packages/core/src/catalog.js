/**
 * Street Code core catalog.
 *
 * Every interval below is a DEFAULT, not gospel. The vehicle manufacturer's manual
 * and the garage's recommendation always win, so every value can be overridden
 * per vehicle (vehicle_service_settings) and per service record.
 *
 * Distance is stored in the vehicle's usage unit: "km" for road vehicles,
 * "hours" for engines that are serviced by engine hours (tractors, generators).
 */

/**
 * Gambian national licence groups.
 *
 * SOURCE: Wikiprocedure "Gambia - Obtain a Drivers License" (community wiki, last edited
 * April 2025). The issuing authority is GAMBIS / the Gambia Police Force Traffic
 * Directorate, whose site blocks automated access, so this could NOT be checked against
 * an official page. Treat it as "best public evidence": confirm with the Traffic
 * Directorate before launch. It is one table on purpose, so correcting it is a one-file change.
 *
 * NOTE: the same wiki page also lists the INTERNATIONAL convention groups A-E (A = motorcycles,
 * B = cars up to 8 seats...) under "International driving permit". Those are a different scheme
 * and are deliberately not used here.
 */
export const LICENCE_GROUPS = {
  A: { label: 'Private motor car' },
  B: { label: 'Motorcycle' },
  C: { label: 'Commercial vehicle' },
  D: { label: 'Motor vehicle of special type' },
};
export const LICENCE_CLASSES = LICENCE_GROUPS; // backwards-compatible alias

/**
 * Which group does a vehicle need?
 *  confidence 'confirmed': follows directly from the group definitions above.
 *  confidence 'assumed':   our best reading; a mismatch is shown to police as a WARNING to verify, never a failure.
 * Commercial use (yellow plate) needs group C whatever the body type.
 */
export function requiredLicenceGroup(vehicleClass, commercialUse = false) {
  const cls = VEHICLE_CLASSES[vehicleClass] || VEHICLE_CLASSES.car;
  if (commercialUse && ['A'].includes(cls.licence)) return { group: 'C', confidence: 'confirmed' };
  return { group: cls.licence, confidence: cls.licenceConfidence || 'confirmed' };
}

export const VEHICLE_CLASSES = {
  car:       { label: 'Car',                unit: 'km',    kmPerDay: 35,  licence: 'A', icon: 'car' },
  suv:       { label: 'SUV / 4x4',          unit: 'km',    kmPerDay: 40,  licence: 'A', icon: 'suv' },
  pickup:    { label: 'Pickup',             unit: 'km',    kmPerDay: 45,  licence: 'A', icon: 'pickup' },
  van:       { label: 'Van',                unit: 'km',    kmPerDay: 70,  licence: 'A', icon: 'van' },
  taxi:      { label: 'Taxi',               unit: 'km',    kmPerDay: 140, licence: 'C', licenceConfidence: 'assumed', icon: 'car', severe: true },
  minibus:   { label: 'Minibus (gele-gele)', unit: 'km',   kmPerDay: 150, licence: 'C', licenceConfidence: 'assumed', icon: 'van', severe: true },
  bus:       { label: 'Bus',                unit: 'km',    kmPerDay: 160, licence: 'C', licenceConfidence: 'assumed', icon: 'bus', severe: true },
  truck:     { label: 'Truck',              unit: 'km',    kmPerDay: 120, licence: 'C', icon: 'truck', heavy: true },
  motorbike: { label: 'Motorbike',          unit: 'km',    kmPerDay: 40,  licence: 'B', icon: 'bike', bike: true },
  tricycle:  { label: 'Tricycle (keke)',    unit: 'km',    kmPerDay: 90,  licence: 'B', licenceConfidence: 'assumed', icon: 'trike', bike: true, severe: true },
  tractor:   { label: 'Tractor',            unit: 'hours', kmPerDay: 4,   licence: 'D', licenceConfidence: 'assumed', icon: 'tractor', heavy: true },
};

export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'lpg'];

/**
 * Oil types. Base intervals per vehicle "family" (car, bike, heavy).
 * `distance` is km (or engine-hours for tractors), `days` is the time limit.
 * Whichever limit is reached first makes the oil due.
 */
export const OIL_TYPES = {
  mineral:        { label: 'Mineral',        note: 'Conventional oil. Shortest life.' },
  semi_synthetic: { label: 'Semi-synthetic', note: 'Blend. Good all-rounder.' },
  full_synthetic: { label: 'Full synthetic', note: 'Longest life and best in heat.' },
};

const OIL_INTERVALS = {
  car: {
    mineral:        { distance: 5000,  days: 180 },
    semi_synthetic: { distance: 7500,  days: 180 },
    full_synthetic: { distance: 10000, days: 365 },
  },
  bike: {
    mineral:        { distance: 2500, days: 120 },
    semi_synthetic: { distance: 4000, days: 180 },
    full_synthetic: { distance: 6000, days: 365 },
  },
  heavy: {
    mineral:        { distance: 8000,  days: 120 },
    semi_synthetic: { distance: 12000, days: 180 },
    full_synthetic: { distance: 15000, days: 270 },
  },
  hours: {
    mineral:        { distance: 250, days: 365 },
    semi_synthetic: { distance: 300, days: 365 },
    full_synthetic: { distance: 500, days: 365 },
  },
};

/** Common oil grades to offer in the "which oil did you use" picker. */
export const OIL_GRADES = ['0W-20', '5W-30', '5W-40', '10W-30', '10W-40', '15W-40', '20W-50', '10W-30 (motorbike JASO MA2)'];

/** Time-only items (no distance component). */
const TIME_ONLY = 'time';

/**
 * Service items. `appliesTo` is a predicate on the vehicle class definition.
 * `intervals(cls, opts)` returns { distance, days } for the class.
 */
export const SERVICE_ITEMS = {
  engine_oil: {
    label: 'Engine oil and filter',
    short: 'Oil',
    icon: 'oil',
    critical: true,
    needsProduct: true,
    appliesTo: () => true,
    intervals: (cls, { oilType = 'semi_synthetic' } = {}) => {
      const family = cls.unit === 'hours' ? 'hours' : cls.bike ? 'bike' : cls.heavy ? 'heavy' : 'car';
      return OIL_INTERVALS[family][oilType] || OIL_INTERVALS[family].semi_synthetic;
    },
  },
  air_filter: {
    label: 'Air filter',
    short: 'Air filter',
    icon: 'filter',
    appliesTo: () => true,
    // Dust shortens this more than anything else on unpaved and harmattan roads.
    intervals: (cls) => (cls.unit === 'hours' ? { distance: 250, days: 365 } : cls.bike ? { distance: 8000, days: 270 } : { distance: 15000, days: 365 }),
  },
  brake_inspection: {
    label: 'Brake pads and discs check',
    short: 'Brakes',
    icon: 'brake',
    critical: true,
    appliesTo: (cls) => cls.unit === 'km',
    intervals: (cls) => (cls.heavy ? { distance: 15000, days: 180 } : { distance: 20000, days: 365 }),
  },
  brake_fluid: {
    label: 'Brake fluid',
    short: 'Brake fluid',
    icon: 'drop',
    critical: true,
    appliesTo: (cls) => cls.unit === 'km',
    intervals: () => ({ distance: 40000, days: 730 }),
  },
  coolant: {
    label: 'Coolant',
    short: 'Coolant',
    icon: 'thermo',
    appliesTo: () => true,
    intervals: (cls) => (cls.unit === 'hours' ? { distance: 1000, days: 730 } : { distance: 60000, days: 1095 }),
  },
  tyre_rotation: {
    label: 'Tyre rotation and pressure',
    short: 'Tyres',
    icon: 'tyre',
    appliesTo: (cls) => cls.unit === 'km' && !cls.bike,
    intervals: () => ({ distance: 10000, days: 180 }),
  },
  transmission_fluid: {
    label: 'Gearbox fluid',
    short: 'Gearbox',
    icon: 'gear',
    appliesTo: () => true,
    intervals: (cls) => (cls.unit === 'hours' ? { distance: 1000, days: 1095 } : { distance: 60000, days: 1460 }),
  },
  battery_check: {
    label: 'Battery check',
    short: 'Battery',
    icon: 'battery',
    appliesTo: () => true,
    intervals: () => ({ distance: TIME_ONLY, days: 365 }),
  },
  wash: {
    label: 'Car wash',
    short: 'Wash',
    icon: 'wash',
    appliesTo: () => true,
    intervals: () => ({ distance: TIME_ONLY, days: 14 }),
  },
};

export const WASH_KINDS = {
  exterior: 'Exterior wash',
  full: 'Full wash (inside and out)',
  engine: 'Engine bay',
  interior: 'Interior valet',
};

/** Alert thresholds shared by the scheduler and the UI. */
export const ALERT_LEVELS = [
  { level: 'soon',     at: 0.8,  title: 'Service coming up' },
  { level: 'urgent',   at: 0.95, title: 'Service due very soon' },
  { level: 'overdue',  at: 1.0,  title: 'Service overdue' },
  { level: 'critical', at: 1.25, title: 'Service seriously overdue' },
];

export const DOCUMENT_KINDS = {
  registration:  { label: 'Registration',        icon: 'doc' },
  insurance:     { label: 'Insurance',           icon: 'shield' },
  road_tax:      { label: 'Road tax',            icon: 'receipt' },
  roadworthiness:{ label: 'Roadworthiness test', icon: 'check-badge' },
};

export const AUTHORIZATION_KINDS = {
  family:   'Family',
  friend:   'Friend',
  rental:   'Rental',
  employee: 'Employee or driver for hire',
  garage:   'Garage (service or test drive)',
};
