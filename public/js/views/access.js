// "Accesos para repartir" (Personal): a new temporary password for everyone who hasn't signed in yet, on cards to
// print (with a QR code that opens the app) or to send one by one by Teams, for when the access emails don't arrive.
import { getSchool, listEmployees, resetNeverSignedIn } from '../backend.js';
import { $, busy, copyText, dialog, html, raw, toast } from '../lib.js';
import { APP_URL } from '../config.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { avatar, empty } from './common.js';
import { neverSignedIn, renderWelcome } from './admin.js';

// The passwords live only here, until the app is closed or reloaded: they aren't kept anywhere.
let batch = null;

/** The app's link with the school code, as a QR code (SVG, dark on white so any camera reads it). */
async function qrSvg(link) {
  const { default: qrcode } = await import('../../vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'Código QR para abrir Hallway' });
}

export async function accessCardsView({ el, isCurrent }) {
  const me = state.me.user;
  const [employees, school] = await Promise.all([listEmployees(), getSchool(state.me.school.id)]);
  if (!isCurrent()) return;
  const link = `${APP_URL}?escuela=${encodeURIComponent(school.code)}`;
  const shortLink = link.replace(/^https?:\/\//, '');

  const renderStart = () => {
    const pending = neverSignedIn(employees, me);
    if (!pending.length) {
      el.innerHTML = String(html`<div class="card">${empty('check', 'Todos ya entraron', 'No hay nadie pendiente de recibir su acceso.')}</div>`);
      return;
    }
    const n = pending.length;
    el.innerHTML = String(html`
      <div class="stack">
        <section class="card stack">
          <h2 class="card-title">${icon('key')} ${n} ${n === 1 ? 'persona no ha entrado' : 'personas no han entrado'}</h2>
          <p>Se crea una <b>contraseña temporal nueva</b> para cada una y se arma una hoja con su usuario, su contraseña y un
            código QR que abre la app.</p>
          <p class="hint">Imprímela para repartirla, o envíale a cada uno su acceso por Teams. La contraseña que se envió por
            correo (o en una hoja anterior) deja de servir. Al entrar, cada persona crea la suya.</p>
          <button type="button" class="btn btn-primary btn-block" data-make>${icon('key', 18)} Crear los accesos</button>
        </section>
        <section class="section">
          <h3 class="section-title">Quiénes <span class="count">${n}</span></h3>
          <div class="list">${pending.map(
            (e) => html`<div class="item">${avatar(e.full_name)}
              <span class="item-main"><strong>${e.full_name}</strong><span class="item-sub">${[e.role_label, e.username].filter(Boolean).join(' · ')}</span></span>
            </div>`,
          )}</div>
        </section>
      </div>`);
    $('[data-make]', el).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ok = await dialog({
        title: `¿Crear accesos para ${n} ${n === 1 ? 'persona' : 'personas'}?`,
        message: 'Cada una tendrá una contraseña temporal nueva. La que se envió por correo dejará de servir.',
        confirmText: 'Crear accesos',
        cancelText: 'Volver',
      });
      if (!ok) return;
      await busy(btn, async () => {
        const res = await resetNeverSignedIn(pending.map((p) => p.id));
        batch = res.people || [];
        if (isCurrent()) await renderCards();
      });
    });
  };

  const renderCards = async () => {
    const done = batch.filter((p) => p.password);
    const failed = batch.filter((p) => !p.password);
    const qr = await qrSvg(link);
    if (!isCurrent()) return;
    el.innerHTML = String(html`
      <div class="stack no-print">
        <p class="status-note ok">${icon('check', 16)} Accesos creados para ${done.length} ${done.length === 1 ? 'persona' : 'personas'}.</p>
        ${failed.length ? html`<p class="status-note warn">${icon('alert', 16)} No se pudo con: ${failed.map((p) => p.full_name).join(', ')}. Inténtalo desde su ficha.</p>` : ''}
        <p class="hint">Imprímelos o envíaselos uno por uno por Teams antes de cerrar la app: estas contraseñas no se vuelven a mostrar.</p>
        <div class="button-row">
          <button type="button" class="btn btn-primary" data-print>${icon('file', 18)} Imprimir</button>
          <a class="btn btn-ghost" href="#/employees">${icon('users', 18)} Volver a Personal</a>
        </div>
      </div>
      <div class="access-sheet">${done.map(
        (p) => html`<article class="access-card">
          <header><strong>${p.full_name}</strong><small>${school.name} · Hallway</small></header>
          <div class="access-body">
            <div class="access-qr">${raw(qr)}</div>
            <dl>
              <dt>Usuario</dt><dd class="mono">${p.username}</dd>
              <dt>Contraseña temporal</dt><dd class="mono">${p.password}</dd>
            </dl>
          </div>
          <ol class="access-steps">
            <li>Escanea el código con la cámara o abre <span class="access-link">${shortLink}</span></li>
            <li>Entra con tu usuario y contraseña.</li>
            <li>La app te pedirá crear tu propia contraseña.</li>
          </ol>
          <div class="button-row no-print">
            <button type="button" class="btn btn-secondary btn-sm" data-copy="${p.id}">${icon('copy', 16)} Copiar mensaje</button>
            ${navigator.share ? html`<button type="button" class="btn btn-ghost btn-sm" data-share="${p.id}">${icon('share', 16)} Compartir</button>` : ''}
          </div>
        </article>`,
      )}</div>`);

    const message = (id) => {
      const p = done.find((x) => x.id === id);
      return renderWelcome(school, p, p.password).text;
    };
    $('[data-print]', el).addEventListener('click', () => window.print());
    for (const b of el.querySelectorAll('[data-copy]')) b.addEventListener('click', () => copyText(message(b.dataset.copy)));
    for (const b of el.querySelectorAll('[data-share]')) {
      b.addEventListener('click', () => navigator.share({ text: message(b.dataset.share) }).catch(() => {}));
    }
    if (failed.length && !done.length) toast('No se pudo crear ningún acceso. Inténtalo de nuevo.', 'error');
  };

  if (batch) await renderCards();
  else renderStart();
}
