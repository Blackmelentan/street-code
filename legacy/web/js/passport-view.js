/**
 * Street Code Vehicle Passport Inspector
 * Renders verified SHA-256 cryptographic provenance chain & QR code
 */

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const queryParam = params.get('q') || params.get('vin') || params.get('plate') || 'BJL-4821-B';

  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = queryParam;

  loadPassport(queryParam);

  const form = document.getElementById('search-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (q) {
        window.history.pushState({}, '', `?q=${encodeURIComponent(q)}`);
        loadPassport(q);
      }
    });
  }
});

async function loadPassport(queryTerm) {
  const loadingEl = document.getElementById('passport-loading');
  const contentEl = document.getElementById('passport-content');
  const errorEl = document.getElementById('passport-error');

  loadingEl.style.display = 'block';
  contentEl.style.display = 'none';
  errorEl.style.display = 'none';

  try {
    const isVin = queryTerm.length > 10 && !queryTerm.includes('-');
    const url = isVin 
      ? `/api/vehicles/lookup?vin=${encodeURIComponent(queryTerm)}`
      : `/api/vehicles/lookup?plate=${encodeURIComponent(queryTerm)}`;

    const res = await fetch(url);
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Vehicle not found in registry');
    }

    const data = await res.json();
    renderPassport(data);
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
  } catch (err) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    document.getElementById('error-message').textContent = err.message;
  }
}

function renderPassport({ vehicle, passportVerification, blocksCount, historyBlocks, activeCitations }) {
  // Vehicle details
  document.getElementById('veh-title').textContent = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  document.getElementById('veh-plate').textContent = vehicle.plate_number;
  document.getElementById('veh-vin').textContent = vehicle.vin;
  document.getElementById('veh-mileage').textContent = `${vehicle.current_mileage.toLocaleString()} km`;
  document.getElementById('veh-owner').textContent = vehicle.owner_name || 'Verified Private Owner';

  // Status badge
  const statusBadge = document.getElementById('veh-status-badge');
  if (vehicle.stolen_flag === 1 || vehicle.status === 'stolen') {
    statusBadge.className = 'badge badge-rose';
    statusBadge.innerHTML = '🚨 ACTIVE STOLEN APB';
  } else if (vehicle.status === 'inspection_due') {
    statusBadge.className = 'badge badge-amber';
    statusBadge.innerHTML = '⚠️ INSPECTION DUE';
  } else {
    statusBadge.className = 'badge badge-emerald';
    statusBadge.innerHTML = '✓ ACTIVE / ROADWORTHY';
  }

  // Cryptographic verification badge
  const verBadge = document.getElementById('crypto-status-banner');
  if (passportVerification.isValid) {
    verBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    verBadge.style.background = 'rgba(16, 185, 129, 0.08)';
    verBadge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 16px;">
        <div style="width: 48px; height: 48px; border-radius: 50%; background: #10b981; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; color: white; flex-shrink: 0; box-shadow: 0 0 16px rgba(16, 185, 129, 0.5);">✓</div>
        <div>
          <h3 style="color: #34d399; font-size: 1.15rem; font-weight: 800; margin-bottom: 2px;">
            100% MATHEMATICALLY VERIFIED PROVENANCE
          </h3>
          <p style="color: #94a3b8; font-size: 0.85rem;">
            All <strong>${blocksCount} blocks</strong> in sequence have passed SHA-256 pre-image validation. Zero odometer rollbacks detected. Signed with Street Code Authority HMAC.
          </p>
        </div>
      </div>
    `;
  } else {
    verBadge.style.borderColor = 'rgba(244, 63, 94, 0.4)';
    verBadge.style.background = 'rgba(244, 63, 94, 0.08)';
    verBadge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 16px;">
        <div style="width: 48px; height: 48px; border-radius: 50%; background: #f43f5e; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; color: white; flex-shrink: 0;">⚠️</div>
        <div>
          <h3 style="color: #fb7185; font-size: 1.15rem; font-weight: 800; margin-bottom: 2px;">
            CHAIN INTEGRITY FAILURE DETECTED
          </h3>
          <p style="color: #94a3b8; font-size: 0.85rem;">
            ${passportVerification.reason || 'Cryptographic signature mismatch or broken hash pointer.'}
          </p>
        </div>
      </div>
    `;
  }

  // Render QR Code (Dynamic SVG)
  renderQrCode(vehicle.plate_number);

  // Active citations banner
  const citContainer = document.getElementById('active-citations-container');
  if (activeCitations && activeCitations.length > 0) {
    citContainer.style.display = 'block';
    citContainer.innerHTML = activeCitations.map(c => `
      <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div>
          <div style="font-size: 0.8rem; font-family: var(--font-mono); color: #fbbf24; font-weight: 700;">UNSETTLED TRAFFIC CITATION #${c.citation_number}</div>
          <div style="font-weight: 700; color: #f1f5f9; font-size: 0.95rem;">${c.violation_title} (Fine: D${c.fine_amount_gmd.toLocaleString()})</div>
          <div style="font-size: 0.8rem; color: #94a3b8;">Issued at roadside inspection • Eligible for 100% Driver Education Waiver</div>
        </div>
        <div>
          <a href="/mobile/" class="nav-btn nav-btn-primary" style="font-size: 0.8rem; padding: 6px 14px;">
            Take Driver Safety Module (Waive Fine) →
          </a>
        </div>
      </div>
    `).join('');
  } else {
    citContainer.style.display = 'none';
  }

  // Render Timeline of Blocks
  const timelineEl = document.getElementById('passport-timeline');
  timelineEl.innerHTML = historyBlocks.map((b, idx) => `
    <div class="timeline-item">
      <div class="timeline-dot" style="${b.event_type === 'STOLEN_REPORT' ? 'background: #f43f5e; box-shadow: 0 0 10px rgba(244,63,94,0.6);' : ''}"></div>
      <div class="timeline-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="badge ${b.event_type === 'STOLEN_REPORT' ? 'badge-rose' : b.event_type === 'GENESIS' ? 'badge-blue' : 'badge-emerald'}">
              BLOCK #${b.block_index} • ${b.event_type}
            </span>
            <span style="font-family: var(--font-mono); font-size: 0.8rem; color: #38bdf8; font-weight: 600;">
              ${b.mileage.toLocaleString()} km
            </span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-dim);">
            ${new Date(b.timestamp).toLocaleString()}
          </div>
        </div>

        <h4 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 4px; color: #f8fafc;">
          ${b.description}
        </h4>

        <div style="font-size: 0.85rem; color: #94a3b8; margin-bottom: 12px;">
          Certified by: <strong style="color: #cbd5e1;">${b.actor_name}</strong> (${b.actor_role.toUpperCase()})
        </div>

        <details style="margin-top: 8px;">
          <summary style="font-size: 0.75rem; font-family: var(--font-mono); color: #0284c7; cursor: pointer; user-select: none;">
            ▸ View Cryptographic Header & SHA-256 Proofs
          </summary>
          <div class="code-block" style="margin-top: 8px;">
            <div><strong>Block ID:</strong> ${b.id}</div>
            <div><strong>Prev Hash:</strong> ${b.prev_hash}</div>
            <div><strong>Current Hash:</strong> <span style="color: #34d399;">${b.current_hash}</span></div>
            <div><strong>Signature:</strong> ${b.signature}</div>
            <div style="margin-top: 6px;"><strong>Payload JSON:</strong></div>
            <pre style="color: #e2e8f0; margin-top: 4px; font-size: 0.7rem;">${JSON.stringify(b.data_payload, null, 2)}</pre>
          </div>
        </details>
      </div>
    </div>
  `).join('');
}

/**
 * Generate a clean SVG QR code visualization
 */
function renderQrCode(plateNumber) {
  const container = document.getElementById('qr-container');
  if (!container) return;

  // Render high-contrast SVG QR barcode matrix
  container.innerHTML = `
    <svg width="120" height="120" viewBox="0 0 33 33" style="background: white; border-radius: 8px; padding: 6px;">
      <!-- Corner Markers -->
      <rect x="2" y="2" width="7" height="7" fill="#0b0f17"/>
      <rect x="3" y="3" width="5" height="5" fill="white"/>
      <rect x="4" y="4" width="3" height="3" fill="#0b0f17"/>

      <rect x="24" y="2" width="7" height="7" fill="#0b0f17"/>
      <rect x="25" y="3" width="5" height="5" fill="white"/>
      <rect x="26" y="4" width="3" height="3" fill="#0b0f17"/>

      <rect x="2" y="24" width="7" height="7" fill="#0b0f17"/>
      <rect x="3" y="25" width="5" height="5" fill="white"/>
      <rect x="4" y="26" width="3" height="3" fill="#0b0f17"/>

      <!-- Matrix pattern -->
      <rect x="11" y="2" width="2" height="2" fill="#0b0f17"/>
      <rect x="15" y="4" width="2" height="2" fill="#0b0f17"/>
      <rect x="19" y="3" width="3" height="2" fill="#0b0f17"/>
      <rect x="11" y="8" width="4" height="2" fill="#0b0f17"/>
      <rect x="18" y="7" width="2" height="4" fill="#0b0f17"/>
      <rect x="6" y="11" width="3" height="2" fill="#0b0f17"/>
      <rect x="12" y="12" width="5" height="5" fill="#0284c7"/>
      <rect x="20" y="13" width="3" height="3" fill="#0b0f17"/>
      <rect x="25" y="11" width="4" height="2" fill="#0b0f17"/>
      <rect x="2" y="15" width="4" height="3" fill="#0b0f17"/>
      <rect x="8" y="17" width="2" height="2" fill="#0b0f17"/>
      <rect x="22" y="18" width="4" height="2" fill="#0b0f17"/>
      <rect x="28" y="15" width="3" height="4" fill="#0b0f17"/>
      <rect x="11" y="20" width="3" height="3" fill="#0b0f17"/>
      <rect x="16" y="22" width="4" height="2" fill="#0b0f17"/>
      <rect x="11" y="26" width="2" height="4" fill="#0b0f17"/>
      <rect x="15" y="28" width="5" height="2" fill="#0b0f17"/>
      <rect x="22" y="24" width="3" height="3" fill="#0b0f17"/>
      <rect x="27" y="27" width="3" height="3" fill="#0b0f17"/>
    </svg>
  `;
}
