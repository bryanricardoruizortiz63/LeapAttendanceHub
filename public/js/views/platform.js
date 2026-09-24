import { $, api, busy, copyText, dialog, fmtDateTime, formValues, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { logout, state } from '../store.js';
import { bindPasswordToggles } from './auth.js';
import { empty } from './common.js';

function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export async function platformView(ctx) {
  const { el } = ctx;
  if (state.me) {
    el.innerHTML = String(html`<div class="auth"><div class="card stack center">
      <p>Cierra la sesión de la escuela para entrar al panel de plataforma.</p>
      <a class="btn btn-secondary" href="#/login">Volver</a></div></div>`);
    return;
  }
  if (!state.platform) return platformLogin(ctx);

  const { schools } = await api('/platform/schools');
  el.innerHTML = String(html`
    <div class="platform">
      <header class="platform-head">
        <div class="row"><img src="/icons/icon.svg" alt="" width="36" height="36">
          <div><h1>Panel de plataforma</h1><small class="muted">Leap Attendance Hub · ${schools.length} escuela(s)</small></div></div>
        <button class="btn btn-ghost btn-sm" data-logout>${icon('logout', 16)} Salir</button>
      </header>

      <form class="card stack" data-create>
        <h2 class="card-title">${icon('plus')} Nueva escuela</h2>
        <label class="field"><span>Nombre de la escuela</span><input name="name" required maxlength="150"></label>
        <div class="grid2">
          <label class="field"><span>Código <em class="optional">vacío = automático</em></span>
            <input name="code" maxlength="20" autocapitalize="characters" spellcheck="false" placeholder="Ej. LEAP-01"></label>
          <label class="field"><span>Contraseña de administración</span>
            <span class="pw"><input name="admin_password" type="text" required minlength="8" value="${randomPassword()}" autocomplete="off">
            <button type="button" class="pw-toggle" data-pw>Ocultar</button></span></label>
        </div>
        <button class="btn btn-primary" type="submit">Crear escuela</button>
      </form>

      <section class="stack">
        ${schools.length
          ? schools.map(
              (s) => html`<div class="card school ${s.active ? '' : 'is-muted'}">
                <div class="row">
                  <div class="grow"><strong>${s.name}</strong>
                    <p class="muted"><span class="mono">${s.code}</span> · ${s.employees} empleados · ${s.absences} ausencias
                    ${s.has_teams ? ' · Teams ✓' : ''}</p>
                    <small class="muted">Creada ${fmtDateTime(s.created_at)}${s.last_absence_at ? ` · última ausencia ${fmtDateTime(s.last_absence_at)}` : ''}</small>
                  </div>
                  ${s.active ? html`<span class="badge badge-ok">Activa</span>` : html`<span class="badge badge-muted">Inactiva</span>`}
                </div>
                <div class="button-row">
                  <button class="btn btn-secondary btn-sm" data-reset="${s.id}">${icon('key', 16)} Nueva contraseña admin</button>
                  <button class="btn btn-ghost btn-sm" data-toggle="${s.id}" data-active="${s.active}">${s.active ? 'Desactivar' : 'Activar'}</button>
                </div>
              </div>`,
            )
          : html`<div class="card">${empty('school', 'Aún no hay escuelas', 'Crea la primera con el formulario de arriba.')}</div>`}
      </section>
    </div>`);

  bindPasswordToggles(el);
  $('[data-logout]', el).addEventListener('click', logout);

  const form = $('[data-create]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      const { school } = await api('/platform/schools', { method: 'POST', body: v });
      const text = `Leap Attendance Hub\nEnlace: ${location.origin}\nEscuela: ${school.name}\nCódigo de escuela: ${school.code}\nContraseña de administración: ${v.admin_password}`;
      const pending = dialog({
        title: 'Escuela creada ✅',
        body: html`<div class="credentials">
            <div><span>Código de escuela</span><strong class="mono">${school.code}</strong></div>
            <div><span>Contraseña de administración</span><strong class="mono">${v.admin_password}</strong></div>
          </div>
          <p class="hint">La dirección entra en la pestaña “Administración” con estos datos.</p>
          <button type="button" class="btn btn-secondary btn-sm" data-copy>${icon('copy', 16)} Copiar</button>`,
        confirmText: 'Listo',
        cancelText: '',
      });
      document.querySelector('dialog.dialog:last-of-type [data-copy]').addEventListener('click', () => copyText(text));
      await pending;
      ctx.reload();
    });
  });

  for (const btn of el.querySelectorAll('[data-reset]')) {
    btn.addEventListener('click', async () => {
      const password = randomPassword();
      const ok = await dialog({
        title: '¿Generar nueva contraseña de administración?',
        message: `La nueva contraseña será: ${password}. Cópiala antes de confirmar.`,
        confirmText: 'Cambiar',
      });
      if (!ok) return;
      await busy(btn, async () => {
        await api(`/platform/schools/${btn.dataset.reset}/admin-password`, { method: 'POST', body: { password } });
        await copyText(password);
        toast('Contraseña cambiada y copiada', 'ok');
      });
    });
  }
  for (const btn of el.querySelectorAll('[data-toggle]')) {
    btn.addEventListener('click', () =>
      busy(btn, async () => {
        await api(`/platform/schools/${btn.dataset.toggle}`, { method: 'PATCH', body: { active: btn.dataset.active !== '1' } });
        ctx.reload();
      }),
    );
  }
}

function platformLogin({ el, reload }) {
  el.innerHTML = String(html`
    <div class="auth">
      <div class="auth-brand">
        <img src="/icons/icon.svg" alt="" class="auth-logo" width="64" height="64">
        <h1>Panel de plataforma</h1>
        <p>Crea y administra las escuelas que usan Leap Attendance Hub.</p>
      </div>
      <form class="card stack" data-form>
        <label class="field"><span>Contraseña de plataforma</span>
          <span class="pw"><input name="password" type="password" required autocomplete="current-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar</button>
        <a class="btn btn-ghost btn-block" href="#/login">Volver</a>
      </form>
    </div>`);
  bindPasswordToggles(el);
  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      await api('/auth/platform-login', { method: 'POST', body: formValues(form) });
      state.platform = true;
      reload();
    });
  });
}
