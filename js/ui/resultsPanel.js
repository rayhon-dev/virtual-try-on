// resultsPanel.js — verdict card + collapsible table of zones.
import { escapeHtml } from './catalogPanel.js';

const ZONE_LABELS = { chest: 'Chest', waist: 'Waist', shoulder: 'Shoulders', sleeve: 'Sleeve', length: 'Length' };

const STATUS_LABELS = {
  width: { tooTight: 'Too tight', tight: 'Snug', good: 'Good', loose: 'Loose', tooLoose: 'Too loose', 'n/a': '—' },
  length: { tooTight: 'Too short', tight: 'Short', good: 'Good', loose: 'Long', tooLoose: 'Too long', 'n/a': '—' },
};

const fmt = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

/**
 * renderResults(container, { evaluation, verdict, hint, zoneRules })
 */
export function renderResults(container, { evaluation, verdict, hint, zoneRules }) {
  const rows = evaluation.zones.map((z) => {
    const kind = zoneRules[z.zone]?.kind === 'length' ? 'length' : 'width';
    const label = STATUS_LABELS[kind][z.status] ?? z.status;

    if (z.status === 'n/a') {
      return `<tr><td>${ZONE_LABELS[z.zone] ?? z.zone}</td><td>—</td><td><span class="chip">${label}</span></td></tr>`;
    }

    // Gauge calculation: ease relative to target range
    const [min, max] = z.target;
    const range = max - min;
    const pct = range > 0 ? Math.max(0, Math.min(100, ((z.ease - min) / range) * 100)) : 50;

    return `
      <tr>
        <td>
          ${ZONE_LABELS[z.zone] ?? z.zone}
          <div class="ease-gauge" title="Ease target: ${min} to ${max}cm">
            <div class="ease-gauge-bar" style="left: ${pct}%; width: 4px; transform: translateX(-50%);"></div>
          </div>
        </td>
        <td>${fmt(z.ease)} CM</td>
        <td>
          <span class="chip ${z.status}">
            ${statusIcon(z.status)} ${label.toUpperCase()}
          </span>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="verdict-card">
      <h2 class="verdict">${escapeHtml(verdict)}</h2>
      <p class="verdict-reason">
        ${evaluation.score}/100 match. ${zonalSummary(evaluation)}
      </p>
      ${hint ? `<p class="hint-note">${escapeHtml(hint)}</p>` : ''}
      <div class="mono-label" style="margin-top: 8px">Confidence: ${evaluation.score > 80 ? 'High' : 'Medium'}</div>
    </div>

    <div class="fit-table-wrap">
      <details ${container.dataset.open === 'true' ? 'open' : ''}>
        <summary class="fit-table-header">
          <span>SHOW DETAILS</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <table class="fit-table">
          <thead><tr><th>ZONE / TARGET</th><th>EASE</th><th>STATUS</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    </div>`;

  // Remember if the user opened details
  container.querySelector('details').ontoggle = (e) => {
    container.dataset.open = e.target.open;
  };
}

function statusIcon(status) {
  if (status === 'good') return '✓';
  if (status === 'tooTight' || status === 'tooLoose') return '×';
  return '△';
}

function zonalSummary(evaluation) {
  const bad = evaluation.zones.filter(z => z.status !== 'good' && z.status !== 'n/a');
  if (bad.length === 0) return 'Everything fits perfectly.';
  const worst = bad[0];
  return `${ZONE_LABELS[worst.zone] ?? worst.zone} is ${worst.status.replace(/([A-Z])/g, ' $1').toLowerCase()}.`;
}
