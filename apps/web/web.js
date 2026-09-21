import { html, raw, esc, $, $$, icon, plate, finishBar, animateIn, fmtDist, fmtDate, fmtNum, STATUS_WORDS, STATUS_TAG, initTheme } from '/design/ui.js';
import { computeItemHealth, VEHICLE_CLASSES, gaugeColor } from '/core/index.js';

initTheme('light');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------
 * The live finish-line demo: the real service engine, in the browser.
 * ------------------------------------------------------------------ */
const CAR = VEHICLE_CLASSES.car; const BASE = 60000; const RATE = 35; const SEGS = 28;

function oilHealth(used, oil) {
  const now = new Date();
  return computeItemHealth({
    code: 'engine_oil', cls: CAR, now, odometer: BASE + used, perDay: RATE,
    last: { performed_at: new Date(now - (used / RATE) * 86400000).toISOString(), odometer: BASE, product: { oil_type: oil } },
  });
}

function setBar(el, pct, status) {
  const p = Math.min(pct, 1);
  el.style.setProperty('--p', p); el.style.setProperty('--c', gaugeColor(pct)); el.dataset.status = status;
  const on = Math.round(p * SEGS);
  $$('.fl-seg', el).forEach((s, i) => s.classList.toggle('on', i < on));
}

const demoBar = $('#demoBar'); demoBar.innerHTML = finishBar({ pct: 0.4, status: 'good' }).toString();
const barEl = $('.fl', demoBar);

function renderDemo() {
  const used = Number($('#used').value);
  const oil = $('input[name=oil]:checked').value;
  const h = oilHealth(used, oil);
  setBar(barEl, h.pct, h.status);
  $('#usedOut').textContent = `${fmtNum(used)} km`;
  const tag = $('#demoTag'); tag.textContent = STATUS_WORDS[h.status]; tag.className = `tag ${STATUS_TAG[h.status]}`;
  const over = h.status === 'overdue' || h.status === 'critical';
  $('#demoLeft').textContent = over ? `${fmtNum(h.overdueDistance)} km over. Change it now.` : h.dueBy === 'time' ? h.message : `${fmtNum(h.remainingDistance)} km to go`;
  $('#demoRight').textContent = `finish line ${fmtDist(h.finishLine.odometer)}`;
}
$('#used').addEventListener('input', renderDemo);
$$('input[name=oil]').forEach((r) => r.addEventListener('change', renderDemo));
renderDemo();
setTimeout(() => barEl.classList.add('go'), reduced ? 0 : 350);

/* Same 6,000 km, three oils */
{
  const rows = [['mineral', 'Mineral'], ['semi_synthetic', 'Semi-synthetic'], ['full_synthetic', 'Full synthetic']].map(([k, label], i) => {
    const h = oilHealth(6000, k);
    const limit = fmtNum(h.intervalDistance);
    return html`<div class="oc-row"><div class="row-between"><b>${label}</b><span class="tag ${STATUS_TAG[h.status]}">${STATUS_WORDS[h.status]}</span></div>
      ${finishBar({ pct: h.pct, status: h.status })}
      <div class="fl-meta"><span>${h.status === 'overdue' ? `${fmtNum(h.overdueDistance)} km over its ${limit} km limit` : `${fmtNum(h.remainingDistance)} km left of ${limit}`}</span><b class="mono">${Math.round(h.pct * 100)}%</b></div></div>`;
  });
  $('#oilCompare').innerHTML = rows.map(String).join('');
  animateIn($('#oilCompare'));
}

/* ------------------------------------------------------------------
 * Stats and garages
 * ------------------------------------------------------------------ */
fetch('/api/public/stats').then((r) => r.json()).then((s) => {
  for (const el of $$('[data-stat]')) {
    const target = Number(s[el.dataset.stat] ?? 0);
    if (reduced || target < 2) { el.textContent = fmtNum(target); continue; }
    const t0 = performance.now();
    const tick = (t) => { const k = Math.min(1, (t - t0) / 1000); el.textContent = fmtNum(Math.round(target * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}).catch(() => $$('[data-stat]').forEach((el) => { el.textContent = '·'; }));

fetch('/api/public/garages').then((r) => r.json()).then(({ garages }) => {
  $('#garageList').innerHTML = garages.length ? garages.map((g) => html`
    <article class="g-card"><div><h4>${g.name}</h4><span class="small muted">${g.location || ''}</span></div>
      <div class="r">${g.rating ? `${g.rating.toFixed(1)}` : ''}<small>${g.open_bays} of ${g.bays} bays open</small></div>
      <div class="cluster">${g.specialties.map((s) => html`<span class="tag">${s}</span>`)}</div></article>`).map(String).join('') : '<p class="muted">Garages will appear here once verified.</p>';
}).catch(() => { $('#garageList').innerHTML = '<p class="muted">The garage list could not be loaded.</p>'; });

/* ------------------------------------------------------------------
 * The public check. No sign-in, no personal data.
 * ------------------------------------------------------------------ */
const TYPE_LABEL = { GENESIS: 'Registered', OWNER_NOTE: 'Owner note', OWNERSHIP_TRANSFER: 'Ownership changed', ROUTINE_SERVICE: 'Service', MAJOR_REPAIR: 'Major repair', OBD_DIAGNOSTIC: 'Diagnostics', ROADWORTHINESS_TEST: 'Roadworthiness test', POLICE_CLEARANCE: 'Police clearance', STOLEN_REPORT: 'Reported stolen', STOLEN_RECOVERED: 'Recovered', CITATION_RESOLVED: 'Citation resolved' };

function renderResult(d, q) {
  if (!d.found) return html`<div class="card empty"><span>${icon('search')}</span><h3>No vehicle found for “${q}”</h3><p style="margin-top:6px">It may not be registered on Street Code yet, or the plate could have been misread. Ask the seller for the VIN and try that.</p></div>`;
  const v = d.vehicle; const p = d.passport;
  const garageSealed = p.garage_sealed_events;
  return html`<div class="res">
    <div class="card">
      <div class="cluster" style="--gap:14px">${plate(v.plate, { commercial: v.commercial, lg: true })}</div>
      <h2 style="margin-top:14px">${v.year} ${v.make} ${v.model}</h2>
      <p class="muted">${v.class_label}${v.color ? ` · ${v.color}` : ''}${v.commercial ? ' · commercial use' : ''}</p>
      ${d.owner_reported_stolen ? html`<div class="notice bad" role="alert">${icon('alert')}<div><b>The owner has reported this vehicle stolen.</b><br>Police have not confirmed it yet, but do not buy it or hand over money until it is cleared.</div></div>` : ''}
      ${d.police_flag ? html`<div class="notice bad" role="alert">${icon('siren')}<div><b>Police have flagged this vehicle.</b><br>Do not buy it or hand over money. Contact the nearest police station.</div></div>` : ''}
      ${p.valid
        ? html`<div class="notice good">${icon('check-badge')}<div><b>History intact.</b><br>${fmtNum(p.blocks)} records, signed and chained since ${fmtDate(p.sealed_since)}.</div></div>`
        : html`<div class="notice bad" role="alert">${icon('alert')}<div><b>This history fails verification.</b><br>${p.reason || 'Records do not match their signatures.'} Treat every claim about this vehicle with suspicion.</div></div>`}
      ${garageSealed === 0 ? html`<div class="notice warn">${icon('info')}<div>No garage has sealed a record for this vehicle yet, so everything shown is self-reported.</div></div>` : ''}
      <div class="facts">
        <div><small>Odometer now</small><b>${fmtNum(d.odometer.current)} ${d.odometer.unit === 'hours' ? 'h' : 'km'}</b></div>
        <div><small>Garage-sealed records</small><b>${garageSealed}</b></div>
      </div>
      <p class="tiny muted" style="margin-top:14px">You are seeing the vehicle's history, never its owner's name, phone number or drivers.</p>
    </div>
    <div class="card">
      <h3>History</h3>
      <ul class="tl">${d.history.map((h) => html`<li class="${h.verified ? 'v' : ''}">
        <div class="t">${TYPE_LABEL[h.type] || h.type}</div>
        <div class="m"><span>${fmtDate(h.at)}</span><span class="mono">${fmtNum(h.mileage)} km</span>${h.verified ? html`<span class="stamp">${icon('check', 'sm')} ${h.by}</span>` : html`<span class="stamp self">${h.by}</span>`}</div>
        ${h.verified && h.description ? html`<div class="small muted" style="margin-top:4px">${h.description}</div>` : ''}</li>`)}</ul>
    </div></div>`;
}

const form = $('#checkForm'); const wrap = $('#check'); const out = $('#result');
async function check(q) {
  q = q.trim(); if (q.length < 3) { $('#q').focus(); return; }
  wrap.classList.remove('hide'); out.innerHTML = '<div class="card"><div class="skeleton" style="height:22px;width:40%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>';
  wrap.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  try {
    const r = await fetch(`/api/public/vehicle?q=${encodeURIComponent(q)}`);
    if (r.status === 429) { out.innerHTML = '<div class="card empty">Too many lookups just now. Try again in a minute.</div>'; return; }
    out.innerHTML = renderResult(await r.json(), q).toString();
  } catch { out.innerHTML = '<div class="card empty">Could not reach the server. Check your connection.</div>'; }
}
form.addEventListener('submit', (e) => { e.preventDefault(); check($('#q').value); });
$$('[data-try]').forEach((b) => b.addEventListener('click', () => { $('#q').value = b.dataset.try; check(b.dataset.try); }));
$$('[data-scroll-check]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => $('#q').focus(), 400); }));
