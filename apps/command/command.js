import { html, raw, esc, $, $$, icon, plate, toast, openSheet, closeAllSheets, fmtNum, fmtDate, fmtDateTime, fmtGmd, timeAgo, makeApi, connectRealtime, initTheme } from '/design/ui.js';
import { FLAG_KINDS, FLAG_INSTRUCTIONS, CHECK_REASONS, LICENCE_GROUPS } from '/core/index.js';

initTheme('dark');
const root = $('#root');
const api = makeApi('sc.command.token', () => { state.user = null; render(); });
const state = { user: null, checks: [], live: false, events: [], stopRt: null, last: null, station: false };
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const fd = (f) => Object.fromEntries(new FormData(f).entries());
const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'bad'); return null; } };

/* ---------------------------------------------------------------- sign in (no built-in credentials) */
async function loginView(message) {
  let devs = null; try { devs = await api.get('/dev/accounts'); } catch { /* production */ }
  root.innerHTML = html`<div class="login"><form class="login-card stack" id="loginForm" style="--gap:16px">
    <img src="/design/brand/command-mark.svg" width="60" height="60" alt="">
    <div><h1>Command</h1><p class="muted">Police access only. Every lookup is recorded against your badge.</p></div>
    ${message ? html`<div class="err" role="alert">${message}</div>` : ''}
    <div class="field"><label>Phone number</label><input class="input" name="phone" type="tel" autocomplete="username" required></div>
    <div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn amber block" type="submit">Sign in</button>
    ${devs ? html`<p class="tiny muted">Demo officers (development only):</p><div class="cluster">${devs.accounts.filter((a) => /Police/.test(a.label)).map((a) => html`<button type="button" class="btn ghost sm" data-quick="${a.phone}" data-pw="${devs.password}">${a.label}</button>`)}</div>` : ''}
  </form></div>`.toString();
  const submit = (phone, password) => run(async () => { const r = await api.post('/auth/login', { phone, password }); api.setToken(r.token); await boot(); });
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); const d = fd(e.target); submit(d.phone, d.password); });
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => submit(b.dataset.quick, b.dataset.pw)));
}

async function boot() {
  if (!api.token()) return loginView();
  try { state.user = (await api.get('/auth/me')).user; } catch { return loginView(); }
  if (!state.user.capabilities.police) { api.clear(); state.user = null; return loginView('This account does not have police access. Officers are added by an administrator.'); }
  state.meta = await api.get('/police/reasons');
  state.stopRt?.();
  state.stopRt = connectRealtime(api.token(), (m) => {
    if (m.type === 'READY') { state.live = true; $('.live')?.classList.add('on'); return; }
    if (m.type === 'FLAG' || m.type === 'SIGHTING') { state.events.unshift({ ...m, at: new Date().toISOString(), fresh: true }); state.events = state.events.slice(0, 40); if (m.type === 'FLAG') toast(`${m.event === 'pending' ? 'New flag awaiting approval' : m.event === 'activated' ? 'Flag activated' : 'Flag cleared'}: ${m.flag.summary}`, m.flag.level === 'red' ? 'bad' : ''); else toast(`Sighting: ${m.plate || m.kind} near ${m.label || 'unknown'}`, 'bad'); if (route() === 'feed') render(); }
  });
  if (!location.hash) location.hash = '#/check';
  render();
}

/* ---------------------------------------------------------------- shell */
const route = () => (location.hash.replace(/^#\//, '') || 'check').split('/')[0];
const NAV = [['check', 'Check', 'plate'], ['flags', 'Flags', 'siren'], ['feed', 'Live', 'radar'], ['trail', 'Trail', 'list']];

async function render() {
  if (!state.user) return loginView();
  const r = route(); const u = state.user;
  const views = { check: checkView, flags: flagsView, feed: feedView, trail: trailView };
  const titles = { check: 'Roadside check', flags: 'Flags and alerts', feed: 'Live picture', trail: 'Audit trail' };
  root.innerHTML = html`<div class="frame"><nav class="rail" aria-label="Main"><div class="logo"><img src="/design/brand/command-mark.svg" width="44" height="44" alt="Street Code Command"></div>
    ${NAV.map(([k, l, ic]) => html`<a href="#/${k}" ${k === r ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${l}</span></a>`)}<div class="sp"></div><button class="rl" id="out">${icon('logout')}<span>Sign out</span></button></nav>
    <div class="main"><header class="head"><h1>${titles[r] || ''}</h1><div class="cluster" style="gap:22px"><span class="live ${state.live ? 'on' : ''}">Live</span><div class="who"><b>${u.name}</b>${u.station ? `${u.station.name} · ${u.station.badge} · ${u.station.role}` : ''}</div></div></header><div id="page"></div></div></div>`.toString();
  $('#out').onclick = () => { state.stopRt?.(); state.stopRt = null; api.clear(); state.user = null; loginView(); };
  const out = await (views[r] || checkView)();
  $('#page').innerHTML = out.html.toString(); out.after?.();
}
window.addEventListener('hashchange', () => state.user && render());

/* ---------------------------------------------------------------- check */
const VERDICT = { clear: ['check-badge', 'Clear'], advisory: ['info', 'Advisory'], action_required: ['alert', 'Action required'], unregistered: ['search', 'Not registered'], flag_hit: ['siren', 'Flag match'] };
const stateIcon = { pass: 'check', warn: 'alert', fail: 'close' };

function resultHtml(r) {
  const v = r.verdict; const [ic, label] = VERDICT[v.outcome] || VERDICT.advisory; const veh = r.vehicle; const d = r.driver;
  return html`<div class="verdict ${v.outcome}" role="status">${icon(ic)}<div><h2>${label}</h2><div>${v.headline}</div>${v.instruction ? html`<div class="big-instruction">${FLAG_INSTRUCTIONS[v.instruction] || v.instruction}</div>` : ''}</div></div>
    <p class="tiny muted" style="margin:8px 4px 16px">${icon('check', 'sm')} Recorded at ${fmtDateTime(new Date())} against your badge. Check reference <span class="mono">${r.checkId}</span>.</p>
    <div class="cols" style="grid-template-columns:1fr 1fr">
      <div class="stack">
        ${veh ? html`<div class="panel"><h3>${icon('car')} Vehicle</h3><div class="cluster" style="margin-bottom:12px">${plate(veh.plate, { commercial: veh.commercial, lg: true })}</div>
          <dl class="kv"><dt>Vehicle</dt><dd>${veh.year} ${veh.make} ${veh.model}</dd><dt>Type</dt><dd>${veh.class_label}${veh.commercial ? ' (commercial)' : ''}, ${veh.color || 'colour not recorded'}</dd><dt>Registered to</dt><dd>${veh.registered_owner}</dd><dt>VIN</dt><dd class="mono small">${veh.vin}</dd><dt>Odometer</dt><dd class="mono">${fmtNum(veh.odometer)} ${veh.unit === 'hours' ? 'h' : 'km'}</dd>${r.health?.overdue?.length ? html`<dt>Safety</dt><dd style="color:var(--amber)">Overdue: ${r.health.overdue.join(', ')}</dd>` : ''}</dl></div>` : ''}
        ${d ? html`<div class="panel"><h3>${icon('wheel')} Driver</h3><dl class="kv"><dt>Name</dt><dd>${d.name}</dd><dt>Declared</dt><dd>${d.declared ? `Yes, since ${fmtDateTime(d.since)}` : 'Not declared. Identified from a licence code.'}</dd>
          ${d.basis ? html`<dt>Authority</dt><dd>${d.basis === 'owner' ? 'Registered owner' : d.basis === 'fleet' ? 'Fleet driver' : `Lent by the owner (${d.authorization?.kind || ''})${d.authorization?.ends_at ? `, until ${fmtDateTime(d.authorization.ends_at)}` : ', open-ended'}`}</dd>` : ''}
          ${d.licence ? html`<dt>Licence</dt><dd><span class="mono">${d.licence.number}</span> · ${d.licence.status}</dd><dt>Groups</dt><dd>${d.licence.groups.map((g) => html`<span class="grp" title="${LICENCE_GROUPS[g]?.label}">${g}</span>`)}</dd><dt>Expires</dt><dd>${fmtDate(d.licence.expires_at)}</dd><dt>Points</dt><dd>${d.licence.points}</dd><dt>Covers this vehicle</dt><dd>${d.licence.covers_vehicle ? html`<span class="tag good">Yes (group ${d.licence.required})</span>` : html`<span class="tag bad">No (needs group ${d.licence.required})</span>`}</dd>` : ''}</dl></div>`
          : html`<div class="panel"><h3>${icon('wheel')} Driver</h3><p class="muted">Nobody has declared they are driving this vehicle. Ask the driver for their licence's live code and check it below.</p></div>`}
      </div>
      <div class="stack">
        ${r.flags?.length ? html`<div class="panel"><h3>${icon('siren')} Flags</h3>${r.flags.map((f) => html`<div class="flagbox ${f.level}"><b>${FLAG_KINDS[f.kind]?.label || f.kind}${f.subject_type === 'person' ? ' (the driver)' : ''}</b> <span class="tag ${f.status === 'active' ? 'bad' : 'warn'}">${f.status === 'reported' ? 'Unconfirmed owner report' : f.status}</span><div style="margin:4px 0">${f.summary}</div><div class="small"><b>${FLAG_INSTRUCTIONS[f.instruction] || f.instruction}</b></div>${f.detail ? html`<div class="small muted" style="margin-top:6px">Restricted: ${f.detail}</div>` : ''}${f.case_ref ? html`<div class="tiny muted mono">Case ${f.case_ref}</div>` : ''}</div>`)}</div>` : ''}
        <div class="panel"><h3>${icon('clipboard')} Checks</h3><div class="checks">${v.checks.map((c) => html`<div class="chk ${c.state}"><span class="mark">${icon(stateIcon[c.state] || 'info')}</span><div><div class="t">${c.label}</div><div class="d">${c.detail}</div></div></div>`)}</div></div>
        ${veh ? html`<div class="cluster"><button class="btn ghost" data-act="note" data-id="${r.checkId}">${icon('edit', 'sm')} Add a note</button><button class="btn ghost" data-act="cite" data-id="${r.checkId}" data-veh="${veh.id}">${icon('receipt', 'sm')} Issue citation</button><button class="btn ghost" data-act="flagFrom" data-plate="${veh.plate}">${icon('siren', 'sm')} Raise flag</button></div>` : ''}
      </div></div>`;
}

async function checkView() {
  const { checks } = await api.get('/police/checks').catch(() => ({ checks: [] }));
  state.checks = checks;
  const at = state.where || { label: '' };
  const page = html`<div class="cols">
    <div class="stack" style="--gap:16px">
      <form class="panel stack" id="checkForm" style="--gap:14px"><input class="platebox" name="query" placeholder="PLATE OR VIN" autocomplete="off" spellcheck="false" autocapitalize="characters" required autofocus>
        <div class="field"><label>Reason for the check</label><select class="input" name="reason">${raw(opts(CHECK_REASONS.map((x) => [x, x])))}</select></div>
        <div class="field"><label>Where are you?</label><div class="cluster" style="flex-wrap:nowrap"><input class="input" name="label" placeholder="e.g. Kairaba Avenue checkpoint" value="${at.label || ''}" required><button type="button" class="btn ghost icon" id="geo" aria-label="Use my location" title="Use my location">${icon('pin')}</button></div><span class="help" id="geoHelp"></span></div>
        <div class="grid" style="grid-template-columns:1fr 1fr"><div class="field"><label>Case reference (optional)</label><input class="input" name="case_ref"></div><div class="field"><label>Driver's licence code (optional)</label><input class="input mono" name="licence_code" placeholder="GM-DL-…" autocomplete="off" spellcheck="false"></div></div>
        <button class="btn amber block" type="submit" style="min-height:54px;font-size:16px">${icon('search')} Check</button></form>
      <form class="panel stack" id="personForm" style="--gap:12px"><h3>${icon('licence')} Check a person by licence code</h3><div class="field"><input class="input mono" name="code" placeholder="GM-DL-204518.ZZ5M-98FK" autocomplete="off" spellcheck="false" required></div><button class="btn ghost block" type="submit">Check person</button></form>
      <div class="panel"><h3>${icon('clock')} Your recent checks</h3><div class="recent">${checks.slice(0, 6).map((c) => html`<button data-quick="${c.query}"><span class="tag ${c.outcome === 'clear' ? 'good' : c.outcome === 'advisory' ? 'warn' : 'bad'}">${c.outcome.replace('_', ' ')}</span><span class="mono grow">${c.query}</span><span class="tiny muted">${timeAgo(c.at)}</span></button>`)}${checks.length ? '' : html`<p class="muted small">Nothing yet.</p>`}</div></div>
    </div>
    <div id="result">${state.last ? resultHtml(state.last) : html`<div class="panel empty">${icon('plate')}<h3 style="justify-content:center;color:var(--fg)">Enter a plate</h3><p class="small" style="max-width:34ch;margin:8px auto 0">You will see documents, who is declared as driving and on whose authority, whether their licence covers the vehicle, and any flags. Nobody needs to be stopped to find out.</p></div>`}</div></div>`;
  return { html: page, after() {
    const f = $('#checkForm'); const submit = async (extra = {}) => {
      const d = { ...fd(f), ...extra };
      if (!d.query) return;
      const r = await run(() => api.post('/police/check', { query: d.query, reason: d.reason, case_ref: d.case_ref || undefined, licence_code: d.licence_code || undefined, location: { label: d.label, ...(state.where?.lat != null ? { lat: state.where.lat, lng: state.where.lng } : {}) } }));
      if (!r) return; state.last = r; state.where = { ...(state.where || {}), label: d.label }; $('#result').innerHTML = resultHtml(r).toString(); $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    f.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $$('[data-quick]').forEach((b) => b.addEventListener('click', () => { f.query.value = b.dataset.quick; submit({ query: b.dataset.quick }); }));
    $('#geo').onclick = () => { $('#geoHelp').textContent = 'Finding you…'; navigator.geolocation?.getCurrentPosition((p) => { state.where = { ...(state.where || {}), lat: p.coords.latitude, lng: p.coords.longitude }; $('#geoHelp').textContent = `Location attached (${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)})`; if (!f.label.value) f.label.value = 'Current location'; }, () => { $('#geoHelp').textContent = 'Could not get your location. Type the place instead.'; }, { timeout: 5000 }) ?? ($('#geoHelp').textContent = 'Location is not available on this device.'); };
    $('#personForm').addEventListener('submit', async (e) => {
      e.preventDefault(); const d = fd(f); if (!d.label) { toast('Say where you are first.', 'bad'); f.label.focus(); return; }
      const r = await run(() => api.post('/police/check-licence', { code: fd(e.target).code, reason: d.reason, case_ref: d.case_ref || undefined, location: { label: d.label, ...(state.where?.lat != null ? { lat: state.where.lat, lng: state.where.lng } : {}) } }));
      if (!r) return; const l = r.licence;
      $('#result').innerHTML = html`<div class="verdict ${r.verdict.outcome}">${icon(VERDICT[r.verdict.outcome][0])}<div><h2>${VERDICT[r.verdict.outcome][1]}</h2><div>${r.verdict.headline}</div>${r.verdict.instruction ? html`<div class="big-instruction">${FLAG_INSTRUCTIONS[r.verdict.instruction]}</div>` : ''}</div></div>
        ${l ? html`<div class="panel" style="margin-top:16px"><h3>${icon('licence')} ${l.holder}</h3><dl class="kv"><dt>Licence</dt><dd class="mono">${l.number} · ${l.status}</dd><dt>Groups</dt><dd>${l.groups.map((g) => html`<span class="grp">${g}</span>`)}</dd><dt>Expires</dt><dd>${fmtDate(l.expires_at)}</dd><dt>Points</dt><dd>${l.points}</dd><dt>Declared driving</dt><dd>${r.declaredVehicles.length ? r.declaredVehicles.map((x) => `${x.plate} (${x.make} ${x.model})`).join(', ') : 'No vehicle'}</dd></dl></div>` : ''}
        <div class="panel" style="margin-top:16px"><div class="checks">${r.verdict.checks.map((c) => html`<div class="chk ${c.state}"><span class="mark">${icon(stateIcon[c.state] || 'info')}</span><div><div class="t">${c.label}</div><div class="d">${c.detail}</div></div></div>`)}</div></div>
        ${r.flags?.map((f) => html`<div class="flagbox ${f.level}"><b>${FLAG_KINDS[f.kind]?.label}</b><div>${f.summary}</div><div class="small"><b>${FLAG_INSTRUCTIONS[f.instruction]}</b></div></div>`) || ''}`.toString();
    });
  } };
}

/* ---------------------------------------------------------------- flags */
let flagTab = 'active';
async function flagsView() {
  const { flags } = await api.get(`/police/flags?status=${flagTab === 'closed' ? 'all' : flagTab === 'pending' ? 'reported' : 'active'}`);
  const rows = flagTab === 'closed' ? flags.filter((f) => ['cleared', 'expired', 'rejected'].includes(f.status)) : flags;
  window.__flags = rows;
  return { html: html`<div class="row-between" style="margin-bottom:16px"><div class="tabs">${[['active', 'Active'], ['pending', 'Awaiting approval'], ['closed', 'Closed']].map(([k, l]) => html`<button data-tab="${k}" aria-pressed="${flagTab === k}">${l}</button>`)}</div><button class="btn amber" id="newFlag">${icon('plus')} New flag</button></div>
    <div class="panel" style="padding:6px 10px 10px;overflow:auto">${rows.length ? html`<table class="t"><thead><tr><th>Subject</th><th>Type</th><th>Summary and instruction</th><th>Raised</th><th></th></tr></thead><tbody>${rows.map((f) => html`<tr><td><span class="lvl ${f.level}"></span><b class="${f.subject.title.length > 12 ? '' : 'mono'}">${f.subject.title}</b><div class="tiny muted" style="margin-left:18px">${f.subject.sub}</div></td>
      <td>${FLAG_KINDS[f.kind]?.label}<div class="tiny muted">${f.subject_type}${f.reported_by_owner ? ' · owner report' : ''}</div></td>
      <td style="max-width:340px">${f.summary}<div class="small" style="color:var(--amber)">${FLAG_INSTRUCTIONS[f.instruction]}</div>${f.detail ? html`<div class="small muted">Restricted: ${f.detail}</div>` : ''}${f.expires_at ? html`<div class="tiny muted">Expires ${fmtDate(f.expires_at)}</div>` : ''}${f.last_seen_label ? html`<div class="tiny muted">Last seen: ${f.last_seen_label}</div>` : ''}</td>
      <td class="small">${f.creator}<div class="tiny muted">${timeAgo(f.created_at)}${f.case_ref ? ` · ${f.case_ref}` : ''}</div></td>
      <td><div class="cluster" style="justify-content:flex-end">${f.can_approve ? html`<button class="btn sm" data-fa="approve" data-id="${f.id}">Approve</button><button class="btn ghost sm" data-fa="reject" data-id="${f.id}">Reject</button>` : ''}${f.status === 'reported' && !f.can_approve ? html`<span class="tag warn">Needs another officer</span>` : ''}${f.status === 'active' && f.kind === 'stolen' && f.subject_type === 'vehicle' ? html`<button class="btn ghost sm" data-fa="track" data-id="${f.id}">${icon('pin', 'sm')} Track</button>` : ''}${['active', 'reported'].includes(f.status) ? html`<button class="btn danger sm" data-fa="clear" data-id="${f.id}">Clear</button>` : html`<span class="tag">${f.status}</span>`}</div></td></tr>`)}</tbody></table>` : html`<div class="empty">${icon('check-badge')}<p>Nothing here.</p></div>`}</div>`,
  after() {
    $$('[data-tab]').forEach((b) => b.onclick = () => { flagTab = b.dataset.tab; render(); });
    $('#newFlag').onclick = () => flagSheet();
    $$('[data-fa]').forEach((b) => b.onclick = () => flagAction(b.dataset.fa, b.dataset.id));
  } };
}

async function flagAction(kind, id) {
  if (kind === 'approve') { if (await run(() => api.post(`/police/flags/${id}/approve`))) { toast('Approved', 'good'); render(); } }
  else if (kind === 'reject') { if (await run(() => api.post(`/police/flags/${id}/reject`, { reason: 'Rejected on review' }))) { render(); } }
  else if (kind === 'clear') {
    openSheet({ title: 'Clear this flag', body: html`<form class="stack" id="clearForm" style="--gap:14px"><p class="muted small">Say why. It goes into the audit trail.</p><div class="field"><label>Reason</label><input class="input" name="reason" required minlength="3" maxlength="200"></div><button class="btn block" type="submit">Clear flag</button></form>`, onMount(el, ctl) { $('#clearForm', el).onsubmit = async (e) => { e.preventDefault(); if (await run(() => api.post(`/police/flags/${id}/clear`, { reason: fd(e.target).reason }))) { ctl.close(); toast('Cleared', 'good'); render(); } }; } });
  } else if (kind === 'track') {
    const t = await run(() => api.get(`/police/flags/${id}/track`)); if (!t) return;
    const pts = [...t.telemetry.map((p) => ({ lat: p.lat, lng: p.lng, label: `${Math.round(p.speed_kph || 0)} km/h`, t: p.ts, k: 'phone' })), ...t.sightings.filter((s) => s.lat != null).map((s) => ({ lat: s.lat, lng: s.lng, label: s.label || 'Sighting', t: s.created_at, k: 'sight' }))];
    openSheet({ title: 'Last known positions', wide: true, body: html`<p class="small muted">Only vehicles on the active stolen list can be tracked, and each look is recorded. Positions are plotted on a plain grid: no map tiles are loaded.</p>${mapSvg(pts)}<ul class="list" style="margin-top:12px">${pts.slice(0, 8).map((p) => html`<li class="li"><span>${icon('pin', 'lead')}</span><div class="grow"><div class="li-title">${p.label}</div><div class="li-sub mono">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · ${timeAgo(p.t)}</div></div></li>`)}</ul>` });
  }
}

function mapSvg(points) {
  const bb = { s: 13.25, n: 13.52, w: -16.85, e: -16.5 }; const W = 700, H = 360;
  const xy = (p) => [((p.lng - bb.w) / (bb.e - bb.w)) * W, (1 - (p.lat - bb.s) / (bb.n - bb.s)) * H];
  const grid = Array.from({ length: 13 }, (_, i) => `<path d="M${(i * W) / 12} 0V${H}" stroke="#1d2224"/>`).join('') + Array.from({ length: 8 }, (_, i) => `<path d="M0 ${(i * H) / 7}H${W}" stroke="#1d2224"/>`).join('');
  const dots = points.filter((p) => p.lat >= bb.s && p.lat <= bb.n && p.lng >= bb.w && p.lng <= bb.e).map((p, i) => { const [x, y] = xy(p); const c = p.k === 'sight' ? '#e5632e' : '#e3a008'; return `<circle cx="${x}" cy="${y}" r="${i === 0 ? 9 : 5}" fill="${c}" opacity="${i === 0 ? 1 : 0.7}"/>${i === 0 ? `<circle cx="${x}" cy="${y}" r="17" fill="none" stroke="${c}" opacity=".5"><animate attributeName="r" from="9" to="26" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" from=".6" to="0" dur="1.6s" repeatCount="indefinite"/></circle>` : ''}`; }).join('');
  return raw(`<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Schematic position plot">${grid}${dots}<text x="10" y="${H - 10}" fill="#5c6668" font-size="11" font-family="monospace">13.25N 16.85W to 13.52N 16.50W (schematic)</text></svg>`);
}

function flagSheet(prefill = {}) {
  const kinds = Object.entries(FLAG_KINDS).map(([k, d]) => [k, `${d.label}${d.needsApproval ? ' (needs supervisor approval)' : ''}`]);
  openSheet({ title: 'New flag', wide: true, body: html`<form id="flagForm" class="stack" style="--gap:14px">
    <div class="field"><label>Type</label><select class="input" name="kind">${raw(opts(kinds, prefill.kind || 'stolen'))}</select></div>
    <div class="field" id="subjV"><label>Plate or VIN</label><input class="input mono" name="plate" value="${prefill.plate || ''}" autocapitalize="characters"></div>
    <div class="field hide" id="subjP"><label>Person's licence number</label><input class="input mono" name="licence_number" placeholder="GM-DL-…"></div>
    <div class="field"><label>Summary an officer will see</label><input class="input" name="summary" required minlength="5" maxlength="200"></div>
    <div class="field"><label>What officers should do</label><select class="input" name="instruction">${raw(opts(Object.entries(FLAG_INSTRUCTIONS), 'call_dispatch'))}</select></div>
    <div class="field"><label>Restricted detail (supervisors and you only)</label><textarea class="input" name="detail" maxlength="2000"></textarea><span class="help" id="detHelp"></span></div>
    <div class="grid" style="grid-template-columns:1fr 1fr"><div class="field"><label>Case reference</label><input class="input" name="case_ref"></div><div class="field"><label>Expires (optional)</label><input class="input" name="expires_at" type="date"></div></div>
    <p class="small muted" id="rule"></p><button class="btn amber block" type="submit">Raise flag</button></form>`, onMount(el, ctl) {
    const f = $('#flagForm', el); const sync = () => { const d = FLAG_KINDS[f.kind.value]; const person = d.subject === 'person'; $('#subjV', el).classList.toggle('hide', person); $('#subjP', el).classList.toggle('hide', !person);
      $('#rule', el).textContent = d.needsApproval ? 'A supervisor other than you must approve this before it takes effect. Nobody can put a person on a list alone.' : f.kind.value === 'stolen' ? 'A case reference is required. It takes effect at once.' : 'It takes effect at once.';
      $('#detHelp', el).textContent = person ? 'Required for a person: record why.' : ''; };
    f.kind.onchange = sync; sync();
    f.onsubmit = async (e) => { e.preventDefault(); const d = fd(f); const body = { kind: d.kind, summary: d.summary, instruction: d.instruction, detail: d.detail || undefined, case_ref: d.case_ref || undefined, expires_at: d.expires_at || undefined };
      if (FLAG_KINDS[d.kind].subject === 'person') body.licence_number = d.licence_number; else body.plate = d.plate;
      const r = await run(() => api.post('/police/flags', body)); if (r) { ctl.close(); toast(r.flag.status === 'active' ? 'Flag is live' : 'Created. Waiting for a supervisor.', 'good'); if (route() === 'flags') render(); } };
  } });
}

/* ---------------------------------------------------------------- live */
async function feedView() {
  const feed = await api.get('/police/feed'); const s = feed.stats;
  const pts = feed.sightings.filter((x) => x.lat != null).map((x, i) => ({ lat: x.lat, lng: x.lng, k: 'sight' }));
  return { html: html`<div class="stats4"><div class="stat4 red"><b>${s.red}</b><span>red alerts in force</span></div><div class="stat4 amber"><b>${s.pending}</b><span>awaiting approval</span></div><div class="stat4"><b>${s.checksToday}</b><span>your checks today</span></div><div class="stat4"><b>${s.hitsToday}</b><span>flag hits today</span></div></div>
    <div class="cols" style="grid-template-columns:1.2fr 1fr"><div class="panel"><h3>${icon('radar')} Sightings</h3>${mapSvg(pts)}<p class="tiny muted" style="margin-top:8px">Where flagged vehicles and people have been checked. Schematic grid; no map tiles.</p></div>
    <div class="panel"><h3>${icon('bell')} Activity</h3>${[...state.events.map((e) => ({ live: true, ...e })), ...feed.sightings.map((x) => ({ type: 'SIGHTING', plate: x.plate, kind: x.kind, level: x.level, label: x.label, at: x.created_at }))].slice(0, 14).map((e) => html`<div class="evt ${e.fresh ? 'new' : ''}"><span class="lvl ${e.level || e.flag?.level || 'amber'}"></span><div><b>${e.type === 'FLAG' ? `${e.flag.kind.replace('_', ' ')} flag ${e.event}` : `${e.plate || 'Person'} sighted`}</b><div class="small muted">${e.type === 'FLAG' ? e.flag.summary : e.label || 'location not recorded'}</div></div><span class="tiny muted">${timeAgo(e.at)}</span></div>`)}</div></div>` };
}

/* ---------------------------------------------------------------- trail */
async function trailView() {
  const sup = state.user.capabilities.supervisor;
  const { checks } = await api.get(`/police/checks${sup && state.station ? '?scope=station' : ''}`);
  return { html: html`${sup ? html`<div class="tabs"><button data-scope="me" aria-pressed="${!state.station}">My checks</button><button data-scope="station" aria-pressed="${state.station}">Whole station</button></div>` : ''}
    <div class="panel" style="overflow:auto;padding:6px 10px 10px">${checks.length ? html`<table class="t"><thead><tr><th>When</th><th>Officer</th><th>Looked up</th><th>Reason and place</th><th>Result</th></tr></thead><tbody>${checks.map((c) => html`<tr><td class="small">${fmtDateTime(c.at)}</td><td class="small">${c.officer}<div class="tiny muted mono">${c.badge || ''}</div></td><td class="mono">${c.query}<div class="tiny muted">${c.kind}</div></td><td class="small">${c.reason}<div class="tiny muted">${c.location || ''}${c.case_ref ? ` · ${c.case_ref}` : ''}</div>${c.notes.map((n) => html`<div class="tiny" style="color:var(--amber)">Note: ${n.note}</div>`)}</td><td><span class="tag ${c.outcome === 'clear' ? 'good' : c.outcome === 'advisory' ? 'warn' : 'bad'}">${c.outcome.replace('_', ' ')}</span></td></tr>`)}</tbody></table>` : html`<div class="empty"><p>No checks yet.</p></div>`}</div>
    <p class="tiny muted" style="margin-top:12px">Every lookup is written by the server the moment it happens. It cannot be edited or deleted, and supervisors can see the whole station's.</p>`,
  after() { $$('[data-scope]').forEach((b) => b.onclick = () => { state.station = b.dataset.scope === 'station'; render(); }); } };
}

/* ---------------------------------------------------------------- delegated sheets on the result panel */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return; const d = t.dataset;
  if (d.act === 'note') openSheet({ title: 'Add a note', body: html`<form id="noteForm" class="stack" style="--gap:14px"><div class="field"><textarea class="input" name="note" required minlength="2" maxlength="1000" placeholder="What happened at the check"></textarea></div><button class="btn block" type="submit">Save note</button></form>`, onMount(el, ctl) { $('#noteForm', el).onsubmit = async (ev) => { ev.preventDefault(); if (await run(() => api.post(`/police/checks/${d.id}/notes`, { note: fd(ev.target).note }))) { ctl.close(); toast('Note saved', 'good'); } }; } });
  if (d.act === 'flagFrom') flagSheet({ plate: d.plate, kind: 'vehicle_of_interest' });
  if (d.act === 'cite') {
    const { offences } = await run(() => api.get('/citations/offences')) || {}; if (!offences) return;
    openSheet({ title: 'Issue a citation', body: html`<form id="citeForm" class="stack" style="--gap:14px"><p class="small muted">Fine amounts are a placeholder schedule until the official one is loaded.</p><div class="field"><label>Offence</label><select class="input" name="code">${raw(opts(Object.entries(offences).map(([k, o]) => [k, `${o.title}, ${fmtGmd(o.fine)}${o.waivable ? ' (waivable)' : ''}`])))}</select></div><button class="btn amber block" type="submit">Issue</button></form>`, onMount(el, ctl) { $('#citeForm', el).onsubmit = async (ev) => { ev.preventDefault(); const r = await run(() => api.post('/police/citations', { vehicle_id: d.veh, check_id: d.id, code: fd(ev.target).code })); if (r) { ctl.close(); toast(`Issued ${r.citation.number}`, 'good'); } }; } });
  }
});

boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => { if (r.scope.endsWith('/command/')) r.unregister(); }));
