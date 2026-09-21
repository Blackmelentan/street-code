/**
 * Service engine. Pure functions, no I/O, no clock: pass `now` in.
 * Used by the API (alerts, verdicts) and by every app (the animated bars).
 */
import { VEHICLE_CLASSES, SERVICE_ITEMS, ALERT_LEVELS } from './catalog.js';

const DAY = 86400000;

const toMs = (d) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(d));
const round1 = (n) => Math.round(n * 10) / 10;

/* ----------------------------------------------------------------------------
 * Usage rate: how far does this vehicle really travel per day?
 * -------------------------------------------------------------------------- */

/**
 * @param {{value:number, recorded_at:string, status?:string}[]} readings
 * @returns {{perDay:number, confidence:'measured'|'estimated', basis:string}}
 */
export function estimateUsageRate(readings, now, { defaultPerDay = 35, windowDays = 120, minSpanDays = 10 } = {}) {
  const nowMs = toMs(now);
  const good = (readings || [])
    .filter((r) => r.status !== 'anomaly' && Number.isFinite(r.value))
    .map((r) => ({ v: r.value, t: toMs(r.recorded_at) }))
    .filter((r) => Number.isFinite(r.t) && r.t <= nowMs)
    .sort((a, b) => a.t - b.t);

  const recent = good.filter((r) => nowMs - r.t <= windowDays * DAY);
  const pool = recent.length >= 2 ? recent : good.slice(-2);

  if (pool.length >= 2) {
    const first = pool[0];
    const last = pool[pool.length - 1];
    const spanDays = (last.t - first.t) / DAY;
    const travelled = last.v - first.v;
    if (spanDays >= minSpanDays && travelled > 0) {
      // Clamp to a sane band so one bad reading cannot wreck every projection.
      const perDay = Math.min(800, Math.max(0.5, travelled / spanDays));
      return { perDay: round1(perDay), confidence: 'measured', basis: `${Math.round(travelled)} over ${Math.round(spanDays)} days` };
    }
  }
  return { perDay: defaultPerDay, confidence: 'estimated', basis: 'typical for this vehicle type' };
}

/* ----------------------------------------------------------------------------
 * The green → red scale. One place, so every bar in every app agrees.
 * -------------------------------------------------------------------------- */

const STOPS = [
  [0.0, [46, 158, 79]],   // green
  [0.55, [141, 182, 0]],  // lime
  [0.8, [227, 160, 8]],   // amber
  [0.92, [229, 99, 46]],  // orange
  [1.0, [198, 40, 40]],   // red
];

export function gaugeColor(pct) {
  const p = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  for (let i = 1; i < STOPS.length; i++) {
    if (p <= STOPS[i][0]) {
      const [p0, c0] = STOPS[i - 1];
      const [p1, c1] = STOPS[i];
      const t = (p - p0) / (p1 - p0 || 1);
      const c = c0.map((x, k) => Math.round(x + (c1[k] - x) * t));
      return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return '#c62828';
}

export function statusForPct(pct) {
  if (pct == null) return 'unknown';
  if (pct >= 1.25) return 'critical';
  if (pct >= 1) return 'overdue';
  if (pct >= 0.85) return 'soon';
  if (pct >= 0.6) return 'watch';
  return 'good';
}

export function alertLevelFor(pct) {
  let hit = null;
  for (const a of ALERT_LEVELS) if (pct >= a.at) hit = a;
  return hit; // null when nothing to say yet
}

const STATUS_RANK = { unknown: 0, good: 1, watch: 2, soon: 3, overdue: 4, critical: 5 };
export const worseStatus = (a, b) => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

/* ----------------------------------------------------------------------------
 * One service item
 * -------------------------------------------------------------------------- */

/**
 * @param {object} p
 * @param {string} p.code            key in SERVICE_ITEMS
 * @param {object} p.cls             VEHICLE_CLASSES entry
 * @param {object|null} p.last       most recent service record for this item
 * @param {number} p.odometer        current odometer (km or hours)
 * @param {number} p.perDay          estimated usage per day
 * @param {number|Date|string} p.now
 * @param {object} [p.override]      { interval_distance, interval_days } per-vehicle
 * @param {boolean} [p.severe]       severe-service (dust, heat, stop-go, heavy load)
 */
export function computeItemHealth({ code, cls, last, odometer, perDay, now, override = null, severe = false }) {
  const def = SERVICE_ITEMS[code];
  const nowMs = toMs(now);
  const unit = cls.unit;

  if (!last) {
    return {
      code, label: def.label, short: def.short, icon: def.icon, critical: !!def.critical,
      status: 'unknown', pct: null, color: '#7c8a8c', unit,
      message: `No ${def.short.toLowerCase()} record yet. Log the last one to start tracking.`,
    };
  }

  // Which interval applies? Record-level override > vehicle override > catalog default.
  const oilType = last.product?.oil_type;
  const base = def.intervals(cls, { oilType });
  let distance = last.interval_distance ?? override?.interval_distance ?? base.distance;
  let days = last.interval_days ?? override?.interval_days ?? base.days;

  // Severe service shortens the interval. Only applied to catalog defaults, never to an explicit override.
  const explicit = last.interval_distance != null || override?.interval_distance != null;
  const severeFactor = severe && !explicit && code === 'engine_oil' ? 0.75 : 1;
  const hasDistance = typeof distance === 'number';
  if (hasDistance) distance = Math.round(distance * severeFactor);
  if (typeof days === 'number' && severeFactor < 1 && last.interval_days == null && override?.interval_days == null) days = Math.round(days * 0.85);

  const lastMs = toMs(last.performed_at);
  const usedDays = Math.max(0, (nowMs - lastMs) / DAY);
  const usedDistance = hasDistance ? Math.max(0, odometer - (last.odometer ?? odometer)) : null;

  const distPct = hasDistance ? usedDistance / distance : 0;
  const timePct = typeof days === 'number' ? usedDays / days : 0;
  const pct = Math.max(distPct, timePct);
  const dueBy = hasDistance && distPct >= timePct ? 'distance' : 'time';

  // The finish line: where and when this item runs out.
  const dueOdometer = hasDistance ? (last.odometer ?? odometer) + distance : null;
  const remainingDistance = hasDistance ? Math.max(0, distance - usedDistance) : null;
  const dueByTime = typeof days === 'number' ? lastMs + days * DAY : null;
  const dueByDistance = hasDistance && perDay > 0 ? nowMs + (remainingDistance / perDay) * DAY : null;
  const candidates = [dueByTime, dueByDistance].filter((x) => x != null);
  const dueMs = candidates.length ? Math.min(...candidates) : null;
  const remainingDays = dueMs != null ? Math.ceil((dueMs - nowMs) / DAY) : null;

  const status = statusForPct(pct);
  return {
    code, label: def.label, short: def.short, icon: def.icon, critical: !!def.critical, unit,
    status, pct: Math.round(pct * 1000) / 1000, color: gaugeColor(pct),
    dueBy,
    intervalDistance: hasDistance ? distance : null,
    intervalDays: typeof days === 'number' ? days : null,
    usedDistance: hasDistance ? Math.round(usedDistance) : null,
    usedDays: Math.floor(usedDays),
    remainingDistance: hasDistance ? Math.round(remainingDistance) : null,
    remainingDays,
    overdueDistance: hasDistance && usedDistance > distance ? Math.round(usedDistance - distance) : 0,
    finishLine: {
      odometer: dueOdometer,
      date: dueMs != null ? new Date(dueMs).toISOString().slice(0, 10) : null,
    },
    lastServicedAt: last.performed_at,
    lastOdometer: last.odometer ?? null,
    product: last.product || null,
    verified: !!last.verified,
    recordId: last.id || null,
    alert: alertLevelFor(pct),
    message: describe({ status, dueBy, remainingDistance, remainingDays, unit, code }),
  };
}

function describe({ status, dueBy, remainingDistance, remainingDays, unit, code }) {
  const u = unit === 'hours' ? 'h' : 'km';
  const n = (x) => Number(x).toLocaleString('en-GB');
  if (status === 'overdue' || status === 'critical') {
    return code === 'wash' ? 'Time for a wash.' : 'Overdue. Book this in now.';
  }
  if (dueBy === 'distance' && remainingDistance != null) return `${n(remainingDistance)} ${u} to go`;
  if (remainingDays != null) return remainingDays <= 1 ? 'Due tomorrow' : `${n(remainingDays)} days to go`;
  return '';
}

/* ----------------------------------------------------------------------------
 * A whole vehicle
 * -------------------------------------------------------------------------- */

/**
 * @param {object} p
 * @param {object} p.vehicle   { vehicle_class, odometer, severe_service }
 * @param {object[]} p.readings odometer readings
 * @param {object[]} p.records  service records (any order)
 * @param {object[]} [p.settings] vehicle_service_settings rows
 */
export function computeVehicleHealth({ vehicle, readings = [], records = [], settings = [], now = new Date() }) {
  const cls = VEHICLE_CLASSES[vehicle.vehicle_class] || VEHICLE_CLASSES.car;
  const rate = estimateUsageRate(readings, now, { defaultPerDay: cls.kmPerDay });
  const severe = !!(vehicle.severe_service ?? cls.severe);

  // Latest record per item
  const latest = {};
  for (const r of records) {
    const cur = latest[r.item_code];
    if (!cur || toMs(r.performed_at) > toMs(cur.performed_at)) latest[r.item_code] = r;
  }
  const overrides = Object.fromEntries((settings || []).map((s) => [s.item_code, s]));

  const items = [];
  for (const [code, def] of Object.entries(SERVICE_ITEMS)) {
    if (!def.appliesTo(cls)) continue;
    if (overrides[code]?.enabled === 0 || overrides[code]?.enabled === false) continue;
    items.push(
      computeItemHealth({ code, cls, last: latest[code] || null, odometer: vehicle.odometer, perDay: rate.perDay, now, override: overrides[code], severe }),
    );
  }

  // Most urgent first. Unknown items sort last so real work is never buried.
  const rank = (i) => (i.status === 'unknown' ? -1 : i.pct);
  items.sort((a, b) => rank(b) - rank(a));

  const tracked = items.filter((i) => i.status !== 'unknown');
  let overall = 'unknown';
  for (const i of tracked) overall = overall === 'unknown' ? i.status : worseStatus(overall, i.status);

  return {
    unit: cls.unit,
    usage: rate,
    overall,
    counts: {
      overdue: items.filter((i) => i.status === 'overdue' || i.status === 'critical').length,
      soon: items.filter((i) => i.status === 'soon').length,
      untracked: items.filter((i) => i.status === 'unknown').length,
    },
    next: tracked[0] || null,
    items,
  };
}

/* ----------------------------------------------------------------------------
 * Documents (insurance, road tax, roadworthiness, registration): time only.
 * -------------------------------------------------------------------------- */

export function computeDocumentHealth(doc, now = new Date()) {
  const nowMs = toMs(now);
  const to = toMs(doc.valid_to);
  const from = doc.valid_from ? toMs(doc.valid_from) : to - 365 * DAY;
  const remainingDays = Math.ceil((to - nowMs) / DAY);
  const span = Math.max(1, to - from);
  const pct = Math.max(0, (nowMs - from) / span);
  let state = 'valid';
  if (remainingDays < 0) state = 'expired';
  else if (remainingDays <= 30) state = 'expiring';
  return { state, remainingDays, pct: Math.round(pct * 1000) / 1000, color: gaugeColor(pct), valid_to: doc.valid_to };
}
