/**
 * Street Code Web Portal - Main Client Script
 */

document.addEventListener('DOMContentLoaded', () => {
  fetchMetrics();
  initSearch();
  initWebSocket();
});

/**
 * Fetch aggregate platform metrics from backend
 */
async function fetchMetrics() {
  try {
    const res = await fetch('/api/audit/metrics/summary');
    if (!res.ok) return;
    const data = await res.json();
    const m = data.metrics;

    document.getElementById('metric-vehicles').textContent = m.registeredVehicles.toLocaleString();
    document.getElementById('metric-blocks').textContent = m.cryptographicPassportBlocks.toLocaleString();
    document.getElementById('metric-momo').textContent = 'D' + (m.momoEscrow.volumeGmd || 0).toLocaleString();
    document.getElementById('metric-workshops').textContent = `${m.workshopBays.occupied}/${m.workshopBays.total} Bays`;
    
    if (m.stolenAlertsActive > 0) {
      const banner = document.getElementById('apb-live-banner');
      if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `🚨 <strong>CIVIC APB ALERT:</strong> ${m.stolenAlertsActive} stolen vehicle broadcast active. <a href="/civic/" style="color: #fca5a5; text-decoration: underline; margin-left: 8px;">View Police Dispatch Feed →</a>`;
      }
    }
  } catch (err) {
    console.warn('Could not fetch metrics:', err.message);
  }
}

/**
 * Initialize search bar behavior
 */
function initSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');

  if (!form || !input) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    // Direct to passport verification page
    window.location.href = `/passport-lookup.html?q=${encodeURIComponent(query)}`;
  });
}

/**
 * Setup real-time WebSocket connection for live telemetry ticker
 */
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  let ws = null;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to Street Code Real-Time WebSocket stream');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'STOLEN_VEHICLE_BROADCAST') {
          showNotification(`🚨 NEW APB: Vehicle ${msg.vehicle.plateNumber} (${msg.vehicle.make} ${msg.vehicle.model}) reported stolen at ${msg.location}!`, 'rose');
          fetchMetrics();
        } else if (msg.type === 'FLEET_BATCH_UPDATE') {
          updateLiveTicker(msg.vehicles);
        }
      } catch (e) {
        // ignore
      }
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 5000); // reconnect
    };
  } catch (err) {
    console.warn('WebSocket connection not available');
  }
}

function updateLiveTicker(vehicles) {
  const tickerEl = document.getElementById('live-fleet-ticker');
  if (!tickerEl || !vehicles || vehicles.length === 0) return;

  const itemsHtml = vehicles.map(v => `
    <span style="display: inline-flex; align-items: center; gap: 6px; margin-right: 24px; font-family: var(--font-mono); font-size: 0.8rem; color: #94a3b8;">
      <span style="width: 6px; height: 6px; border-radius: 50%; background: #10b981;"></span>
      <strong style="color: #f1f5f9;">${v.plateNumber}</strong>
      <span>${v.speed_kph} km/h</span>
      <span style="color: #64748b;">${v.coolant_temp_c}°C</span>
    </span>
  `).join('');

  tickerEl.innerHTML = itemsHtml;
}

function showNotification(text, type = 'emerald') {
  const toast = document.createElement('div');
  toast.className = `badge badge-${type}`;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 16px 20px;
    font-size: 0.95rem;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    z-index: 1000;
    max-width: 420px;
    animation: slideUp 0.3s ease-out;
  `;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}
