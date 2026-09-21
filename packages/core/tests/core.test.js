import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateUsageRate, computeItemHealth, computeVehicleHealth, computeDocumentHealth,
  gaugeColor, statusForPct, alertLevelFor, VEHICLE_CLASSES, checkLicence, buildVerdict, requiredLicenceGroup,
} from '../src/index.js';

const NOW = new Date('2026-09-19T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const car = VEHICLE_CLASSES.car;

/* ------------------------------ usage rate ------------------------------ */

test('usage rate is measured from odometer readings over time', () => {
  const r = estimateUsageRate([
    { value: 70000, recorded_at: daysAgo(60) },
    { value: 72400, recorded_at: daysAgo(0) },
  ], NOW);
  assert.equal(r.confidence, 'measured');
  assert.equal(r.perDay, 40); // 2400 km / 60 days
});

test('usage rate falls back to a typical value when there is too little data', () => {
  const r = estimateUsageRate([{ value: 1000, recorded_at: daysAgo(2) }], NOW, { defaultPerDay: 35 });
  assert.equal(r.confidence, 'estimated');
  assert.equal(r.perDay, 35);
});

test('usage rate ignores anomalous readings', () => {
  const r = estimateUsageRate([
    { value: 70000, recorded_at: daysAgo(40) },
    { value: 10, recorded_at: daysAgo(20), status: 'anomaly' },
    { value: 71000, recorded_at: daysAgo(0) },
  ], NOW);
  assert.equal(r.perDay, 25);
});

test('usage rate needs a real time span (two readings on one day are not a rate)', () => {
  const r = estimateUsageRate([
    { value: 1000, recorded_at: daysAgo(1) },
    { value: 1300, recorded_at: daysAgo(0) },
  ], NOW, { defaultPerDay: 35 });
  assert.equal(r.confidence, 'estimated');
});

/* ------------------------------- the bar -------------------------------- */

test('oil: distance limit is reached first, finish line is the due odometer', () => {
  // Semi-synthetic car oil: 7,500 km / 180 days. 3,000 km and 30 days in.
  const h = computeItemHealth({
    code: 'engine_oil', cls: car, now: NOW, odometer: 63000, perDay: 100,
    last: { performed_at: daysAgo(30), odometer: 60000, product: { oil_type: 'semi_synthetic' } },
  });
  assert.equal(h.intervalDistance, 7500);
  assert.equal(h.dueBy, 'distance');
  assert.equal(h.pct, 0.4);
  assert.equal(h.status, 'good');
  assert.equal(h.finishLine.odometer, 67500);
  assert.equal(h.remainingDistance, 4500);
  // 4,500 km at 100 km/day = 45 days from now, which is before the 150 days left by time
  assert.equal(h.remainingDays, 45);
});

test('oil: full synthetic lasts longer than mineral for the same distance', () => {
  const mk = (oil_type) => computeItemHealth({
    code: 'engine_oil', cls: car, now: NOW, odometer: 65000, perDay: 30,
    last: { performed_at: daysAgo(20), odometer: 60000, product: { oil_type } },
  });
  const mineral = mk('mineral');       // 5,000 km limit: 5,000 used = due
  const synthetic = mk('full_synthetic'); // 10,000 km limit
  assert.equal(mineral.status, 'overdue');
  assert.equal(synthetic.status, 'good');
  assert.ok(synthetic.pct < mineral.pct);
});

test('oil: time limit wins when the car barely moves', () => {
  // Mineral: 5,000 km / 180 days. Only 400 km in 200 days.
  const h = computeItemHealth({
    code: 'engine_oil', cls: car, now: NOW, odometer: 60400, perDay: 2,
    last: { performed_at: daysAgo(200), odometer: 60000, product: { oil_type: 'mineral' } },
  });
  assert.equal(h.dueBy, 'time');
  assert.ok(h.pct > 1);
  assert.equal(h.status, 'overdue');
});

test('oil: severe service (taxi, dust, heat) shortens the interval by a quarter', () => {
  const base = { code: 'engine_oil', cls: car, now: NOW, odometer: 63000, perDay: 30, last: { performed_at: daysAgo(10), odometer: 60000, product: { oil_type: 'semi_synthetic' } } };
  const normal = computeItemHealth(base);
  const severe = computeItemHealth({ ...base, severe: true });
  assert.equal(normal.intervalDistance, 7500);
  assert.equal(severe.intervalDistance, 5625);
});

test('an explicit override is never shortened by severe service', () => {
  const h = computeItemHealth({
    code: 'engine_oil', cls: car, now: NOW, odometer: 63000, perDay: 30, severe: true,
    last: { performed_at: daysAgo(10), odometer: 60000, product: { oil_type: 'semi_synthetic' }, interval_distance: 6000 },
  });
  assert.equal(h.intervalDistance, 6000);
});

test('tractors are serviced by engine hours, not km', () => {
  const tractor = VEHICLE_CLASSES.tractor;
  const h = computeItemHealth({
    code: 'engine_oil', cls: tractor, now: NOW, odometer: 1300, perDay: 4,
    last: { performed_at: daysAgo(30), odometer: 1100, product: { oil_type: 'mineral' } },
  });
  assert.equal(h.unit, 'hours');
  assert.equal(h.intervalDistance, 250);
  assert.equal(h.finishLine.odometer, 1350);
  assert.equal(h.pct, 0.8);        // 200 of 250 hours
  assert.equal(h.status, 'watch'); // 'soon' starts at 85%
});

test('motorbikes get shorter oil intervals than cars', () => {
  const bike = VEHICLE_CLASSES.motorbike;
  const h = computeItemHealth({ code: 'engine_oil', cls: bike, now: NOW, odometer: 1000, perDay: 40, last: { performed_at: daysAgo(5), odometer: 500, product: { oil_type: 'mineral' } } });
  assert.equal(h.intervalDistance, 2500);
});

test('car wash is time-only: no distance, due by date', () => {
  const h = computeItemHealth({ code: 'wash', cls: car, now: NOW, odometer: 60000, perDay: 40, last: { performed_at: daysAgo(10), odometer: 59900 } });
  assert.equal(h.intervalDistance, null);
  assert.equal(h.finishLine.odometer, null);
  assert.equal(h.intervalDays, 14);
  assert.equal(h.remainingDays, 4);
  assert.equal(h.dueBy, 'time');
});

test('an item with no record is unknown, not green', () => {
  const h = computeItemHealth({ code: 'engine_oil', cls: car, now: NOW, odometer: 1, perDay: 30, last: null });
  assert.equal(h.status, 'unknown');
  assert.equal(h.pct, null);
});

/* ----------------------------- colours/status ---------------------------- */

test('gauge runs green to red and is clamped', () => {
  assert.equal(gaugeColor(0), '#2e9e4f');
  assert.equal(gaugeColor(1), '#c62828');
  assert.equal(gaugeColor(5), '#c62828');
  assert.equal(gaugeColor(-1), '#2e9e4f');
  assert.notEqual(gaugeColor(0.5), gaugeColor(0.9));
});

test('status thresholds', () => {
  assert.equal(statusForPct(0.3), 'good');
  assert.equal(statusForPct(0.7), 'watch');
  assert.equal(statusForPct(0.9), 'soon');
  assert.equal(statusForPct(1.0), 'overdue');
  assert.equal(statusForPct(1.3), 'critical');
  assert.equal(statusForPct(null), 'unknown');
});

test('alert levels escalate, and stay quiet early on', () => {
  assert.equal(alertLevelFor(0.5), null);
  assert.equal(alertLevelFor(0.8).level, 'soon');
  assert.equal(alertLevelFor(0.97).level, 'urgent');
  assert.equal(alertLevelFor(1.1).level, 'overdue');
  assert.equal(alertLevelFor(1.4).level, 'critical');
});

/* ------------------------------- whole car ------------------------------- */

test('vehicle health ranks the most urgent item first and reports the worst status', () => {
  const health = computeVehicleHealth({
    now: NOW,
    vehicle: { vehicle_class: 'car', odometer: 68000 },
    readings: [{ value: 60000, recorded_at: daysAgo(80) }, { value: 68000, recorded_at: daysAgo(0) }],
    records: [
      { item_code: 'engine_oil', performed_at: daysAgo(80), odometer: 60000, product: { oil_type: 'mineral' } }, // 8,000 of 5,000: overdue
      { item_code: 'wash', performed_at: daysAgo(2), odometer: 67800 },
    ],
  });
  assert.equal(health.overall, 'critical');
  assert.equal(health.items[0].code, 'engine_oil');
  assert.equal(health.usage.perDay, 100);
  assert.ok(health.counts.overdue >= 1);
  assert.ok(health.counts.untracked > 0);
});

test('a tractor is not offered tyre rotation or brake checks', () => {
  const codes = computeVehicleHealth({ now: NOW, vehicle: { vehicle_class: 'tractor', odometer: 100 } }).items.map((i) => i.code);
  assert.ok(!codes.includes('tyre_rotation'));
  assert.ok(!codes.includes('brake_inspection'));
  assert.ok(codes.includes('engine_oil'));
});

test('documents: valid, expiring, expired', () => {
  const mk = (d) => computeDocumentHealth({ valid_from: daysAgo(300), valid_to: new Date(NOW.getTime() + d * 86400000).toISOString() }, NOW).state;
  assert.equal(mk(120), 'valid');
  assert.equal(mk(10), 'expiring');
  assert.equal(mk(-3), 'expired');
});

/* -------------------------------- licence -------------------------------- */

const goodLicence = { status: 'valid', classes: ['A'], expires_at: '2030-01-01T00:00:00Z' };

test('licence: Gambian groups. A is a private car, B a motorcycle, C commercial, D special type', () => {
  assert.equal(requiredLicenceGroup('car').group, 'A');
  assert.equal(requiredLicenceGroup('motorbike').group, 'B');
  assert.equal(requiredLicenceGroup('truck').group, 'C');
  assert.equal(requiredLicenceGroup('tractor').group, 'D');
});

test('licence: commercial use of a private-type vehicle needs group C (yellow plate)', () => {
  assert.equal(requiredLicenceGroup('van', false).group, 'A');
  assert.equal(requiredLicenceGroup('van', true).group, 'C');
  assert.equal(checkLicence(goodLicence, 'van', NOW, { commercialUse: true }).level === 'ok', false);
});

test('licence: group A may drive a car; a confirmed mismatch (truck, motorbike) fails', () => {
  assert.equal(checkLicence(goodLicence, 'car', NOW).ok, true);
  assert.equal(checkLicence(goodLicence, 'truck', NOW).ok, false);
  assert.equal(checkLicence(goodLicence, 'motorbike', NOW).ok, false);
  assert.equal(checkLicence({ ...goodLicence, classes: ['A', 'B'] }, 'motorbike', NOW).ok, true);
});

test('licence: an ASSUMED mapping (tractor, keke, taxi) only warns, it never tells police to act on a guess', () => {
  for (const cls of ['tractor', 'tricycle', 'taxi', 'minibus']) {
    const r = checkLicence(goodLicence, cls, NOW);
    assert.equal(r.level, 'warn', cls);
    assert.equal(r.ok, true, cls);
    assert.match(r.reasons.join(' '), /Verify/, cls);
  }
});

test('licence: resident-permit commercial clearance must be current', () => {
  const l = { ...goodLicence, classes: ['A', 'C'], commercial_clearance_until: '2026-01-01T00:00:00Z' };
  const r = checkLicence(l, 'truck', NOW);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /clearance/i);
  assert.equal(checkLicence({ ...l, commercial_clearance_until: '2027-01-01T00:00:00Z' }, 'truck', NOW).ok, true);
});

test('licence: expired, suspended and missing licences fail; unverified only warns', () => {
  assert.equal(checkLicence({ ...goodLicence, expires_at: '2020-01-01T00:00:00Z' }, 'car', NOW).ok, false);
  assert.equal(checkLicence({ ...goodLicence, status: 'suspended' }, 'car', NOW).ok, false);
  assert.equal(checkLicence(null, 'car', NOW).ok, false);
  const pending = checkLicence({ ...goodLicence, status: 'pending' }, 'car', NOW);
  assert.equal(pending.ok, true);
  assert.equal(pending.level, 'warn');
});

/* -------------------------------- verdict -------------------------------- */

const okDocs = ['registration', 'insurance', 'road_tax', 'roadworthiness'].map((kind) => ({ kind, valid_from: daysAgo(100), valid_to: new Date(NOW.getTime() + 200 * 86400000).toISOString(), status: 'verified' }));
const vehicle = { id: 'v1', vehicle_class: 'car' };

test('verdict: clean vehicle with the owner driving is clear', () => {
  const v = buildVerdict({ vehicle, documents: okDocs, flags: [], personFlags: [], session: { driver_name: 'Fatou' }, driverIsOwner: true, driverLicence: goodLicence, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'clear');
});

test('verdict: no declared driver is an advisory, not a failure', () => {
  const v = buildVerdict({ vehicle, documents: okDocs, flags: [], personFlags: [], session: null, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'advisory');
  assert.equal(v.checks.find((c) => c.id === 'driver').state, 'warn');
});

test('verdict: someone driving with no authorisation from the owner needs action', () => {
  const v = buildVerdict({ vehicle, documents: okDocs, flags: [], personFlags: [], session: { driver_name: 'Stranger' }, driverIsOwner: false, authorization: null, driverLicence: goodLicence, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'action_required');
  assert.equal(v.checks.find((c) => c.id === 'driver').state, 'fail');
});

test('verdict: an authorised friend with a valid licence is clear', () => {
  const v = buildVerdict({ vehicle, documents: okDocs, flags: [], personFlags: [], session: { driver_name: 'Friend' }, driverIsOwner: false, authorization: { kind: 'friend', ends_at: '2026-09-21T18:00:00Z' }, driverLicence: goodLicence, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'clear');
});

test('verdict: authorised, but the licence does not cover the vehicle', () => {
  const v = buildVerdict({ vehicle: { ...vehicle, vehicle_class: 'truck' }, documents: okDocs, flags: [], personFlags: [], session: { driver_name: 'Friend' }, driverIsOwner: false, authorization: { kind: 'friend' }, driverLicence: goodLicence, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'action_required');
  assert.match(v.checks.find((c) => c.id === 'licence').detail, /group C/);
});

test('verdict: expired insurance fails; expiring soon only warns', () => {
  const docs = okDocs.map((d) => (d.kind === 'insurance' ? { ...d, valid_to: daysAgo(3) } : d.kind === 'road_tax' ? { ...d, valid_to: new Date(NOW.getTime() + 5 * 86400000).toISOString() } : d));
  const v = buildVerdict({ vehicle, documents: docs, flags: [], personFlags: [], session: { driver_name: 'X' }, driverIsOwner: true, driverLicence: goodLicence, openCitations: 0 }, NOW);
  assert.equal(v.outcome, 'action_required');
  assert.equal(v.checks.find((c) => c.id === 'insurance').state, 'fail');
  assert.equal(v.checks.find((c) => c.id === 'road_tax').state, 'warn');
});

test('verdict: an active red flag outranks everything and carries its instruction', () => {
  const v = buildVerdict({
    vehicle, documents: okDocs, session: { driver_name: 'X' }, driverIsOwner: true, driverLicence: goodLicence, openCitations: 0, personFlags: [],
    flags: [{ id: 'f1', kind: 'stolen', level: 'red', status: 'active', summary: 'Stolen 19 Sep', instruction: 'call_dispatch' }],
  }, NOW);
  assert.equal(v.outcome, 'flag_hit');
  assert.equal(v.instruction, 'call_dispatch');
});

test('verdict: an unconfirmed owner report is visible but is not a red hit yet', () => {
  const v = buildVerdict({
    vehicle, documents: okDocs, session: { driver_name: 'X' }, driverIsOwner: true, driverLicence: goodLicence, openCitations: 0, personFlags: [],
    flags: [{ id: 'f1', kind: 'stolen', level: 'red', status: 'reported', summary: 'Owner reports stolen', instruction: 'verify_owner' }],
  }, NOW);
  assert.equal(v.outcome, 'action_required');
  assert.equal(v.flags.length, 1);
});

test('verdict: a person flag on the declared driver surfaces on the vehicle check', () => {
  const v = buildVerdict({
    vehicle, documents: okDocs, session: { driver_name: 'X' }, driverIsOwner: true, driverLicence: goodLicence, openCitations: 0, flags: [],
    personFlags: [{ id: 'p1', kind: 'wanted', level: 'red', status: 'active', summary: 'Wanted for questioning', instruction: 'call_dispatch' }],
  }, NOW);
  assert.equal(v.outcome, 'flag_hit');
  assert.equal(v.flags[0].on, 'person');
});
