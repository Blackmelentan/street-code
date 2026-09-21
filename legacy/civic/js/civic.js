/**
 * Street Code Civic Command Center - Workstation Engine
 * Handles real-time fleet map, roadside procedural search logging (Gap 5),
 * APB stolen vehicle alerts, and immutable audit logs.
 */

let activeUser = {
  id: 'usr-police-01',
  name: 'Sergeant Ebrima Jallow',
  role: 'police',
  badgeNumber: 'GPF-4092',
  token: null
};

let ws = null;
let allVehicles = [];

document.addEventListener('DOMContentLoaded', async () => {
  await authenticateActiveUser();
  initWebSocket();
  loadFleetTelemetry();
  loadStolenAlerts();
  loadSearchLogs();
  loadAuditLogs();
  setupEventListeners();
});

/**
 * Authenticate session for Police Sergeant or Admin
 */
async function authenticateActiveUser() {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+2207111222', password: 'streetcode123' })
    });
    const data = await res.json();
    activeUser.token = data.token;
    activeUser.id = data.user.id;
    activeUser.name = data.user.name;
    activeUser.badgeNumber = data.user.badge_number;
    document.getElementById('current-officer-badge').textContent = `${activeUser.name} [${activeUser.badgeNumber}]`;
  } catch (err) {
    console.error('Civic auth error:', err);
  }
}

/**
 * Initialize real-time WebSocket connection
 */
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('ws-status-badge').innerHTML = '<span class="civic-status-dot"></span> CONNECTED (LIVE)';
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'FLEET_BATCH_UPDATE') {
        updateMapMarkers(data.vehicles);
      } else if (data.type === 'STOLEN_VEHICLE_BROADCAST') {
        handleNewStolenBroadcast(data);
      } else if (data.type === 'STOLEN_VEHICLE_RECOVERED') {
        loadStolenAlerts();
        loadFleetTelemetry();
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    document.getElementById('ws-status-badge').innerHTML = '<span class="civic-status-dot" style="background:#f43f5e; box-shadow:none;"></span> RECONNECTING...';
    setTimeout(initWebSocket, 4000);
  };
}

/**
 * Load fleet vehicles & initialize markers on tactical map
 */
async function loadFleetTelemetry() {
  try {
    const res = await fetch('/api/fleet/telemetry');
    const data = await res.json();
    allVehicles = data.fleet;
    updateMapMarkers(allVehicles);
    renderFleetList(allVehicles);
  } catch (err) {
    console.error('Fleet error:', err);
  }
}

/**
 * Render vehicle markers on tactical coordinate map
 */
function updateMapMarkers(vehicles) {
  const mapEl = document.getElementById('tactical-map');
  if (!mapEl) return;

  vehicles.forEach((v) => {
    let marker = document.getElementById(`marker-${v.vehicle_id || v.vehicleId}`);
    
    // Normalize coordinates to percentage inside Banjul bounding box
    // Lat: 13.40 to 13.48 (North/South), Lon: -16.72 to -16.55 (West/East)
    const lat = v.latitude || 13.4549;
    const lon = v.longitude || -16.5790;
    const topPct = Math.max(8, Math.min(92, 100 - ((lat - 13.40) / 0.08) * 100));
    const leftPct = Math.max(8, Math.min(92, ((lon - (-16.72)) / 0.17) * 100));

    const isStolen = v.stolen_flag === 1 || v.status === 'stolen';

    if (!marker) {
      marker = document.createElement('div');
      marker.id = `marker-${v.vehicle_id || v.vehicleId}`;
      marker.className = 'map-marker';
      mapEl.appendChild(marker);
    }

    marker.style.top = `${topPct}%`;
    marker.style.left = `${leftPct}%`;

    const pinBg = isStolen ? '#f43f5e' : (v.speed_kph > 0 ? '#10b981' : '#38bdf8');
    const pinIcon = isStolen ? '🚨' : (v.speed_kph > 0 ? '▶' : '■');

    marker.innerHTML = `
      <div class="map-marker-pin" style="background: ${pinBg};">
        ${pinIcon}
      </div>
      <div class="map-marker-label" style="${isStolen ? 'border-color: #f43f5e; color: #fb7185;' : ''}">
        <strong>${v.plate_number || v.plateNumber}</strong> (${Math.round(v.speed_kph || 0)} km/h)
      </div>
    `;

    marker.onclick = () => selectVehicleFromMap(v);
  });
}

function renderFleetList(vehicles) {
  const container = document.getElementById('fleet-list-container');
  if (!container) return;

  container.innerHTML = vehicles.map(v => {
    const isStolen = v.stolen_flag === 1;
    return `
      <div class="card-item ${isStolen ? 'stolen' : ''}" onclick="selectVehicleFromMap(${JSON.stringify(v).replace(/"/g, '&quot;')})" style="cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <strong style="font-family: var(--font-mono); font-size: 0.9rem; color: ${isStolen ? '#fb7185' : '#f8fafc'};">
            ${v.plate_number}
          </strong>
          <span class="badge ${isStolen ? 'badge-rose' : 'badge-emerald'}">
            ${isStolen ? 'STOLEN' : 'ACTIVE'}
          </span>
        </div>
        <div style="font-size: 0.8rem; color: var(--civic-muted);">
          ${v.year || ''} ${v.make} ${v.model}
        </div>
        <div style="display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 0.75rem; color: var(--civic-dim); margin-top: 6px;">
          <span>Speed: <strong style="color: #cbd5e1;">${Math.round(v.speed_kph)} km/h</strong></span>
          <span>Fuel: <strong style="color: #cbd5e1;">${Math.round(v.fuel_level_pct)}%</strong></span>
        </div>
      </div>
    `;
  }).join('');
}

function selectVehicleFromMap(v) {
  const plate = v.plate_number || v.plateNumber;
  document.getElementById('search-plate-input').value = plate;
  inspectVehicleRoadside(plate);
}

/**
 * Roadside Checkpoint Plate Inspection (GAP 5)
 */
async function inspectVehicleRoadside(plate) {
  const resultBox = document.getElementById('roadside-inspection-result');
  resultBox.style.display = 'block';
  resultBox.innerHTML = '<div style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--civic-muted);">Querying National Registry & Passport Chain...</div>';

  try {
    const res = await fetch(`/api/vehicles/lookup?plate=${encodeURIComponent(plate)}`);
    if (!res.ok) {
      resultBox.innerHTML = `
        <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 6px; padding: 10px; font-size: 0.85rem;">
          ⚠️ <strong>UNREGISTERED VEHICLE:</strong> Plate <em>${plate}</em> not found in National Registry. Flag for manual document inspection.
        </div>
      `;
      return;
    }

    const data = await res.json();
    const v = data.vehicle;
    const isStolen = v.stolen_flag === 1;

    document.getElementById('search-vin-hidden').value = v.vin;

    resultBox.innerHTML = `
      <div style="background: ${isStolen ? 'rgba(244, 63, 94, 0.15)' : 'rgba(16, 185, 129, 0.1)'}; border: 1px solid ${isStolen ? '#f43f5e' : 'rgba(16, 185, 129, 0.3)'}; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="color: ${isStolen ? '#fb7185' : '#34d399'}; font-size: 1rem;">
            ${isStolen ? '🚨 ALERT: STOLEN VEHICLE MATCH' : '✓ REGISTRY VERIFIED'}
          </strong>
          <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--civic-muted);">${v.plate_number}</span>
        </div>
        <div style="font-size: 0.85rem; margin-bottom: 4px;">${v.year} ${v.make} ${v.model} (${v.color})</div>
        <div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--civic-muted);">
          VIN: <span style="color: #38bdf8;">${v.vin}</span> • Passport Blocks: <span style="color: #34d399;">${data.blocksCount}</span>
        </div>
        ${isStolen ? `<div style="margin-top: 8px; font-weight: 700; color: #fca5a5; font-size: 0.85rem;">Notes: ${v.stolen_notes}</div>` : ''}
      </div>
    `;

    if (isStolen) {
      document.getElementById('search-reason-select').value = 'Suspected Stolen Vehicle Match';
      document.getElementById('search-findings-input').value = `STOLEN MATCH CONFIRMED at checkpoint. Vehicle detained. Notes: ${v.stolen_notes}`;
    }
  } catch (e) {
    resultBox.innerHTML = `<div style="color: #f43f5e; font-size: 0.85rem;">Lookup failed: ${e.message}</div>`;
  }
}

/**
 * Submit Mandatory Procedural Police Roadside Search Log (GAP 5)
 */
async function submitRoadsideSearch(e) {
  e.preventDefault();
  const plate = document.getElementById('search-plate-input').value.trim();
  const vin = document.getElementById('search-vin-hidden').value || 'UNKNOWN';
  const checkpoint = document.getElementById('search-checkpoint-select').value;
  const reason = document.getElementById('search-reason-select').value;
  const findings = document.getElementById('search-findings-input').value.trim();

  if (!plate || !findings) {
    alert('Vehicle plate and detailed findings are mandatory for police roadside search accountability.');
    return;
  }

  try {
    const res = await fetch('/api/police/search-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeUser.token}`
      },
      body: JSON.stringify({
        vehicle_vin: vin,
        vehicle_plate: plate,
        location_checkpoint: checkpoint,
        search_reason: reason,
        search_findings: findings
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    alert(`✓ Search Log #${data.logId} permanently recorded under Badge ${data.officerBadge}.`);
    document.getElementById('search-findings-input').value = '';
    loadSearchLogs();
    loadAuditLogs();
  } catch (err) {
    alert('Failed to log roadside search: ' + err.message);
  }
}

/**
 * Load logged roadside searches
 */
async function loadSearchLogs() {
  try {
    const res = await fetch('/api/police/search-logs', {
      headers: { 'Authorization': `Bearer ${activeUser.token}` }
    });
    const data = await res.json();
    const container = document.getElementById('search-logs-container');
    if (!container) return;

    container.innerHTML = data.logs.map(l => `
      <div class="card-item">
        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-family: var(--font-mono); color: var(--civic-muted); margin-bottom: 4px;">
          <span style="color: #38bdf8; font-weight: 700;">${l.vehicle_plate}</span>
          <span>${new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div style="font-size: 0.8rem; font-weight: 700; color: #f1f5f9; margin-bottom: 2px;">${l.location_checkpoint}</div>
        <div style="font-size: 0.75rem; color: #f59e0b; margin-bottom: 4px;">Justification: ${l.search_reason}</div>
        <div style="font-size: 0.75rem; color: #94a3b8; background: #0b101c; padding: 6px; border-radius: 4px;">${l.search_findings}</div>
        <div style="font-size: 0.7rem; font-family: var(--font-mono); color: var(--civic-dim); margin-top: 4px;">Officer: ${l.officer_badge}</div>
      </div>
    `).join('');
  } catch (e) {}
}

/**
 * Load Active Stolen APB Alerts
 */
async function loadStolenAlerts() {
  try {
    const res = await fetch('/api/police/stolen-alerts');
    const data = await res.json();
    const container = document.getElementById('apb-alerts-container');
    if (!container) return;

    if (data.alerts.length === 0) {
      container.innerHTML = '<div style="color: var(--civic-dim); font-size: 0.8rem; font-family: var(--font-mono); padding: 12px 0;">NO ACTIVE STOLEN VEHICLE ALERTS</div>';
      return;
    }

    container.innerHTML = data.alerts.map(a => `
      <div class="card-item stolen">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="font-family: var(--font-mono); font-size: 0.95rem; color: #fb7185;">${a.plate_number}</strong>
          <span class="badge badge-rose">ACTIVE APB</span>
        </div>
        <div style="font-size: 0.85rem; font-weight: 700;">${a.year} ${a.make} ${a.model} (${a.color})</div>
        <div style="font-size: 0.75rem; color: #cbd5e1; margin-top: 4px;">📍 Last Seen: ${a.last_seen_location}</div>
        <div style="font-size: 0.75rem; color: #fca5a5; margin-top: 4px; font-style: italic;">"${a.details}"</div>
        
        <div style="margin-top: 10px; display: flex; gap: 8px;">
          <button onclick="recoverStolenVehicle('${a.id}', '${a.vehicle_id}')" class="btn-action btn-success" style="font-size: 0.75rem; padding: 5px 10px;">
            ✓ Recover & Clear Flag
          </button>
        </div>
      </div>
    `).join('');
  } catch (e) {}
}

async function recoverStolenVehicle(apbId, vehicleId) {
  const notes = prompt('Enter vehicle recovery inspection notes:', 'Vehicle intercepted at checkpoint. Verified undamaged.');
  if (notes === null) return;

  try {
    const res = await fetch('/api/police/recover-stolen', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeUser.token}`
      },
      body: JSON.stringify({ apbId, vehicleId, recoveryNotes: notes })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    alert('Vehicle safely recovered. Stolen APB broadcast cleared.');
    loadStolenAlerts();
    loadFleetTelemetry();
    loadAuditLogs();
  } catch (err) {
    alert('Recovery action failed: ' + err.message);
  }
}

function handleNewStolenBroadcast(data) {
  loadStolenAlerts();
  loadFleetTelemetry();
  alert(`🚨 HIGH-PRIORITY APB BROADCAST:\nPlate: ${data.vehicle.plateNumber}\nVehicle: ${data.vehicle.make} ${data.vehicle.model}\nLocation: ${data.location}\nDetails: ${data.details}`);
}

/**
 * Broadcast new Stolen Vehicle APB Alert
 */
async function submitNewApb(e) {
  e.preventDefault();
  const vehicleId = document.getElementById('apb-modal-vehicle-select').value;
  const location = document.getElementById('apb-modal-location-input').value.trim();
  const details = document.getElementById('apb-modal-details-input').value.trim();

  if (!vehicleId || !location || !details) {
    alert('Please fill out all APB broadcast fields.');
    return;
  }

  try {
    const res = await fetch('/api/police/stolen-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeUser.token}`
      },
      body: JSON.stringify({ vehicle_id: vehicleId, last_seen_location: location, details })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeApbModal();
    loadStolenAlerts();
    loadFleetTelemetry();
    loadAuditLogs();
    alert('APB Alert broadcast nationwide to all checkpoint consoles and patrolling units.');
  } catch (err) {
    alert('Broadcast failed: ' + err.message);
  }
}

/**
 * Load System Audit Logs
 */
async function loadAuditLogs() {
  try {
    const res = await fetch('/api/audit/logs?limit=25', {
      headers: { 'Authorization': `Bearer ${activeUser.token}` }
    });
    const data = await res.json();
    const container = document.getElementById('audit-logs-container');
    if (!container) return;

    container.innerHTML = data.logs.map(log => `
      <div style="font-family: var(--font-mono); font-size: 0.75rem; border-bottom: 1px solid #1e293b; padding: 8px 0;">
        <div style="display: flex; justify-content: space-between; color: var(--civic-dim);">
          <span>${new Date(log.timestamp).toLocaleTimeString()}</span>
          <span style="color: #0284c7;">${log.actor_role.toUpperCase()}</span>
        </div>
        <div style="font-weight: 700; color: #cbd5e1; margin-top: 2px;">${log.action}</div>
        <div style="color: #64748b; font-size: 0.7rem;">Target: ${log.target_type} #${log.target_id.slice(0,10)}</div>
      </div>
    `).join('');
  } catch (e) {}
}

function openApbModal() {
  // Populate vehicle dropdown
  const select = document.getElementById('apb-modal-vehicle-select');
  select.innerHTML = allVehicles.filter(v => v.stolen_flag === 0).map(v => `
    <option value="${v.id || v.vehicle_id}">${v.plate_number} - ${v.make} ${v.model}</option>
  `).join('');

  document.getElementById('apb-modal').style.display = 'flex';
}

function closeApbModal() {
  document.getElementById('apb-modal').style.display = 'none';
}

function setupEventListeners() {
  const roadsideForm = document.getElementById('roadside-search-form');
  if (roadsideForm) roadsideForm.addEventListener('submit', submitRoadsideSearch);

  const apbForm = document.getElementById('apb-broadcast-form');
  if (apbForm) apbForm.addEventListener('submit', submitNewApb);

  const plateInput = document.getElementById('search-plate-input');
  if (plateInput) {
    plateInput.addEventListener('change', (e) => {
      if (e.target.value.trim()) inspectVehicleRoadside(e.target.value.trim());
    });
  }
}
