import { $, ROLE_LABELS, api, busy, formValues, html, isManager, timeAgo, toast } from '../lib.js';
import { icon } from '../icons.js';
import { currentPushSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported } from '../pwa.js';
import { logout, setUnread, state } from '../store.js';
import { bindPasswordToggles } from './auth.js';
import { avatar, empty, installHint } from './common.js';

// ---- Push toggle card ----------------------------------------------------------

async function pushCard(slot, { compact = false } = {}) {
  if (!slot) return;
  const supported = pushSupported();
  const sub = supported ? await currentPushSubscription().catch(() => null) : null;
  const enabled = !!sub && Notification.permission === 'granted';
  if (compact && enabled) {
    slot.innerHTML = '';
    return;
  }

  let content;
  if (!supported) {
    content = isIos() && !isStandalone()
      ? html`<p class="muted">Para recibir notificaciones en iPhone, primero añade la app a tu pantalla de inicio y ábrela desde allí.</p>`
      : html`<p class="muted">Este navegador no admite notificaciones push. Verás los avisos dentro de la app.</p>`;
  } else if (enabled) {
    content = html`<p class="status-note ok">${icon('check', 16)} Activadas en este dispositivo</p>
      <div class="button-row">
        <button class="btn btn-secondary btn-sm" data-push-test>${icon('send', 16)} Probar</button>
        <button class="btn btn-ghost btn-sm" data-push-off>Desactivar</button>
      </div>`;
  } else {
    content = html`<p class="muted">Recibe un aviso en tu teléfono ${isManager(state.me.user) || state.me.user.role === 'secretary'
      ? 'cada vez que alguien reporte una ausencia.'
      : 'cuando la dirección reciba tu ausencia o te deje un comentario.'}</p>
      <button class="btn btn-primary btn-sm" data-push-on>${icon('bell', 16)} Activar notificaciones</button>`;
  }
  slot.innerHTML = String(html`<section class="card stack"><h2 class="card-title">${icon('bell')} Notificaciones en este teléfono</h2>${content}</section>`);

  $('[data-push-on]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await enablePush();
      toast('Notificaciones activadas', 'ok');
      await pushCard(slot, { compact });
    }),
  );
  $('[data-push-off]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await disablePush();
      toast('Notificaciones desactivadas');
      await pushCard(slot, { compact });
    }),
  );
  $('[data-push-test]', slot)?.addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      await api('/push/test', { method: 'POST' });
      toast('Enviada. Debería llegarte en unos segundos.', 'ok');
    }),
  );
}

// ---- Avisos -----------------------------------------------------------------------

export async function notificationsView({ el, isCurrent, onLeave }) {
  const load = async () => {
    const { notifications, unread } = await api('/notifications');
    if (!isCurrent()) return;
    setUnread(unread);
    el.innerHTML = String(html`
      <div data-push-slot></div>
      ${notifications.length
        ? html`
          <div class="list-head">
            <p class="muted">${unread ? `${unread} sin leer` : 'Todo leído'}</p>
            ${unread ? html`<button class="btn btn-ghost btn-sm" data-read-all>${icon('check', 16)} Marcar todo como leído</button>` : ''}
          </div>
          <div class="list">${notifications.map(
            (n) => html`<a class="item notif ${n.read_at ? '' : 'unread'}" href="${n.link || '#/notifications'}" data-id="${n.id}">
              <span class="notif-icon">${icon('bell', 18)}</span>
              <span class="item-main">
                <strong>${n.title}</strong>
                ${n.body ? html`<span class="item-sub">${n.body}</span>` : ''}
                <span class="item-time">${timeAgo(n.created_at)}</span>
              </span>
            </a>`,
          )}</div>`
        : empty('bell', 'No tienes avisos', 'Aquí aparecerán las novedades sobre las ausencias.')}`);

    pushCard($('[data-push-slot]', el), { compact: true });
    $('[data-read-all]', el)?.addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        await api('/notifications/read-all', { method: 'POST' });
        await load();
      }),
    );
    for (const a of el.querySelectorAll('.notif.unread')) {
      a.addEventListener('click', () => {
        api(`/notifications/${a.dataset.id}/read`, { method: 'POST' }).catch(() => {});
      });
    }
  };
  await load();
  const onPush = () => load().catch(() => {});
  window.addEventListener('lah:push', onPush);
  onLeave(() => window.removeEventListener('lah:push', onPush));
}

// ---- Perfil -----------------------------------------------------------------------

export async function profileView({ el }) {
  const { user, school } = state.me;
  el.innerHTML = String(html`
    <div class="stack">
      <section class="card profile-head">
        ${avatar(user.full_name, 'xl')}
        <h2>${user.full_name}</h2>
        <p class="muted">${user.position || ROLE_LABELS[user.role]}</p>
        <div class="profile-meta">
          <span>${icon('school', 16)} ${school.name}</span>
          <span>${icon('key', 16)} ${school.code} · ${user.username}</span>
        </div>
      </section>

      ${user.role !== 'admin' && user.role !== 'teacher'
        ? html`<a class="card link-card" href="#/home">${icon('calendar')}<span><strong>Mis ausencias</strong><small>Tus propias ausencias y su estado</small></span>${icon('chevron', 18)}</a>`
        : ''}

      <div data-push-slot></div>
      <div data-install-slot></div>

      ${user.role !== 'admin'
        ? html`<form class="card stack" data-contact>
            <h2 class="card-title">${icon('user')} Mis datos de contacto</h2>
            <label class="field"><span>Correo</span><input name="email" type="email" value="${user.email || ''}" autocapitalize="none"></label>
            <label class="field"><span>Teléfono</span><input name="phone" type="tel" value="${user.phone || ''}"></label>
            <button class="btn btn-secondary" type="submit">Guardar</button>
          </form>`
        : ''}

      <form class="card stack" data-password>
        <h2 class="card-title">${icon('key')} Cambiar contraseña</h2>
        <label class="field"><span>Contraseña actual</span>
          <span class="pw"><input name="current_password" type="password" required autocomplete="current-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <label class="field"><span>Nueva contraseña (mín. 8)</span>
          <span class="pw"><input name="new_password" type="password" required minlength="8" autocomplete="new-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <button class="btn btn-secondary" type="submit">Cambiar contraseña</button>
      </form>

      <button class="btn btn-ghost-danger btn-block" data-logout>${icon('logout', 18)} Cerrar sesión</button>
      <p class="hint center">Leap Attendance Hub</p>
    </div>`);

  bindPasswordToggles(el);
  pushCard($('[data-push-slot]', el));
  installHint($('[data-install-slot]', el), { dismissible: false });
  $('[data-logout]', el).addEventListener('click', logout);

  const contact = $('[data-contact]', el);
  contact?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(contact.querySelector('[type=submit]'), async () => {
      const v = formValues(contact);
      await api('/me', { method: 'PATCH', body: v });
      Object.assign(state.me.user, v);
      toast('Datos guardados', 'ok');
    });
  });

  const pw = $('[data-password]', el);
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(pw.querySelector('[type=submit]'), async () => {
      const v = formValues(pw);
      if (v.new_password.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres.');
      await api('/me/password', { method: 'POST', body: v });
      pw.reset();
      toast('Contraseña actualizada', 'ok');
    });
  });
}

// ---- Más (staff) ----------------------------------------------------------------

export async function moreView({ el }) {
  const { user } = state.me;
  const manager = isManager(user);
  const links = [
    manager ? ['#/report', 'plus', 'Registrar ausencia', 'Para ti o para un empleado'] : null,
    user.role !== 'admin' ? ['#/home', 'calendar', 'Mis ausencias', 'Tus propias ausencias'] : null,
    manager ? ['#/settings', 'teams', 'Escuela y Teams', 'Nombre, código, Teams y contraseña de administración'] : null,
    manager ? ['#/data', 'chart', 'Datos y reportes', 'Estadísticas, exportar a Excel y respaldo'] : null,
    ['#/profile', 'user', 'Mi perfil', 'Notificaciones, contraseña e instalar la app'],
  ].filter(Boolean);

  el.innerHTML = String(html`
    <div class="stack">
      <div class="list">${links.map(
        ([href, ic, title, sub]) => html`<a class="item" href="${href}">
          <span class="item-icon">${icon(ic)}</span>
          <span class="item-main"><strong>${title}</strong><span class="item-sub">${sub}</span></span>
          ${icon('chevron', 18)}
        </a>`,
      )}</div>
      <button class="btn btn-ghost-danger btn-block" data-logout>${icon('logout', 18)} Cerrar sesión</button>
    </div>`);
  $('[data-logout]', el).addEventListener('click', logout);
}

