import { CATEGORIES, STATUS, colorIndex, fmtRange, html, initials, scheduleText, $ } from '../lib.js';
import { icon } from '../icons.js';
import { canPromptInstall, isIos, isStandalone, promptInstall } from '../pwa.js';

export function avatar(name, size = '') {
  return html`<span class="avatar c${colorIndex(name)} ${size}" aria-hidden="true">${initials(name)}</span>`;
}

export function statusBadge(status) {
  const s = STATUS[status] || STATUS.pending;
  return html`<span class="badge ${s.cls}">${s.label}</span>`;
}

export function empty(iconName, title, text = '', action = '') {
  return html`<div class="empty">${icon(iconName, 40)}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action}</div>`;
}

function dateChip(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  return html`<span class="date-chip"><b>${d.getDate()}</b><small>${d.toLocaleDateString('es', { month: 'short' }).replace('.', '')}</small></span>`;
}

/** One absence row. showName=false is used for the employee's own list. */
export function absenceItem(a, { showName = true } = {}) {
  const cancelled = a.status === 'cancelled';
  const sub = [
    showName ? fmtRange(a.start_date, a.end_date) : null,
    scheduleText(a),
    a.category ? CATEGORIES[a.category] : null,
  ].filter(Boolean);
  let coverage = '';
  if (!cancelled && a.substitute) coverage = html`<span class="tag tag-ok">${icon('check', 14)} ${a.substitute}</span>`;
  else if (!cancelled && showName) coverage = html`<span class="tag tag-warn">Sin cubrir</span>`;

  return html`
    <a class="item ${cancelled ? 'is-muted' : ''}" href="#/absence/${a.id}">
      ${showName ? avatar(a.employee_name) : dateChip(a.start_date)}
      <span class="item-main">
        <strong>${showName ? a.employee_name : fmtRange(a.start_date, a.end_date)}</strong>
        <span class="item-sub">${sub.join(' · ')}</span>
        <span class="item-tags">
          ${coverage}
          ${a.attachment_count ? html`<span class="tag">${icon('clip', 14)} ${a.attachment_count}</span>` : ''}
          ${a.comment_count ? html`<span class="tag">${icon('chat', 14)} ${a.comment_count}</span>` : ''}
        </span>
      </span>
      ${statusBadge(a.status)}
    </a>`;
}

export function absenceList(items, opts) {
  return html`<div class="list">${items.map((a) => absenceItem(a, opts))}</div>`;
}

/** Renders an "add to home screen" hint into slot when the app is not installed yet. */
export function installHint(slot, { dismissible = true } = {}) {
  if (!slot || isStandalone()) return;
  const KEY = 'lah:install-dismissed';
  try {
    if (dismissible && localStorage.getItem(KEY)) return;
  } catch {
    /* storage unavailable */
  }

  const render = () => {
    let bodyHtml;
    if (isIos()) {
      bodyHtml = html`<p>En Safari toca ${icon('share', 16)} <b>Compartir</b> y luego <b>“Añadir a pantalla de inicio”</b>.
        Así la abres como una app y recibes notificaciones.</p>`;
    } else if (canPromptInstall()) {
      bodyHtml = html`<p>Instálala en tu teléfono para abrirla con un toque y recibir notificaciones.</p>
        <button class="btn btn-primary btn-sm" data-install>${icon('download', 16)} Instalar app</button>`;
    } else {
      bodyHtml = html`<p>Desde el menú del navegador elige <b>“Instalar app”</b> o <b>“Añadir a pantalla de inicio”</b>.</p>`;
    }
    slot.innerHTML = String(html`
      <div class="install card">
        <span class="install-icon">${icon('phone', 22)}</span>
        <div class="install-body"><strong>Añade la app a tu pantalla de inicio</strong>${bodyHtml}</div>
        ${dismissible ? html`<button class="icon-btn" data-dismiss aria-label="Cerrar">${icon('x', 18)}</button>` : ''}
      </div>`);
    $('[data-install]', slot)?.addEventListener('click', async () => {
      if (await promptInstall()) slot.innerHTML = '';
    });
    $('[data-dismiss]', slot)?.addEventListener('click', () => {
      try {
        localStorage.setItem(KEY, '1');
      } catch {
        /* ignore */
      }
      slot.innerHTML = '';
    });
  };
  render();
  const onInstallable = () => slot.isConnected && render();
  window.addEventListener('lah:installable', onInstallable, { once: true });
}
