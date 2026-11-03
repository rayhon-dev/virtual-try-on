// catalogPanel.js — garment cards for the drawer.
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function jacketIcon(color) {
  return `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M23 8 32 15 41 8 54 13 59 45 51 47 48 27 48 57 16 57 16 27 13 47 5 45 10 13Z" fill="${color}"/>
      <path d="M32 15V57" stroke="rgba(255,255,255,.45)" stroke-width="1.2"/>
    </svg>`;
}

export function renderCatalog(container, { garments, selectedId, badges = {}, onSelect }) {
  if (!garments.length) {
    container.innerHTML = '<p class="empty-state">No items in this category for your avatar yet.</p>';
    return;
  }
  container.innerHTML = `
    <div class="catalog-grid">
      ${garments.map((g) => `
        <button type="button" class="card-garment" data-id="${escapeHtml(g.id)}" aria-pressed="${g.id === selectedId}">
          <span class="card-thumb">
            ${g.image ? `<img src="${escapeHtml(g.image)}" alt="" loading="lazy">` : jacketIcon(g.color ?? '#888')}
          </span>
          <span class="card-name">${escapeHtml(g.name)}</span>
          <span class="card-meta">${capitalize(g.designFit)} Fit</span>
          ${badges[g.id] ? `<span class="size-badge" title="Recommended size for you">${escapeHtml(badges[g.id])}</span>` : ''}
        </button>`).join('')}
    </div>`;

  container.onclick = (event) => {
    const card = event.target.closest('.card-garment');
    if (card) onSelect(card.dataset.id);
  };
}
