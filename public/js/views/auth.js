import { $, api, busy, formValues, html, toast } from '../lib.js';
import { icon } from '../icons.js';
import { syncPush } from '../pwa.js';
import { go, homePath, logout, state } from '../store.js';
import { installHint } from './common.js';

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function passwordField(name, label, autocomplete) {
  return html`
    <label class="field"><span>${label}</span>
      <span class="pw">
        <input name="${name}" type="password" required autocomplete="${autocomplete}" minlength="${name === 'password' || name === 'current_password' ? 1 : 8}">
        <button type="button" class="pw-toggle" data-pw>Ver</button>
      </span>
    </label>`;
}

export function bindPasswordToggles(root) {
  for (const btn of root.querySelectorAll('[data-pw]')) {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Ocultar' : 'Ver';
    });
  }
}

export async function loginView({ el, query }) {
  let mode = query.get('mode') === 'admin' ? 'admin' : 'staff';

  const render = () => {
    el.innerHTML = String(html`
      <div class="auth">
        <div class="auth-brand">
          <img src="/icons/icon.svg" alt="" class="auth-logo" width="72" height="72">
          <h1>Leap Attendance Hub</h1>
          <p>Reporta tus ausencias en segundos y mantén informada a la dirección.</p>
        </div>
        <div class="card auth-card">
          <div class="segmented" role="tablist">
            <button type="button" role="tab" class="seg ${mode === 'staff' ? 'active' : ''}" data-mode="staff"
              aria-selected="${mode === 'staff'}">${icon('user', 18)} Personal</button>
            <button type="button" role="tab" class="seg ${mode === 'admin' ? 'active' : ''}" data-mode="admin"
              aria-selected="${mode === 'admin'}">${icon('shield', 18)} Administración</button>
          </div>
          <form class="stack" data-login novalidate>
            <label class="field"><span>Código de escuela</span>
              <input name="school_code" required autocapitalize="characters" autocomplete="organization"
                spellcheck="false" placeholder="Ej. LEAP-2045" value="${recall('lah:school')}">
            </label>
            ${mode === 'staff'
              ? html`<label class="field"><span>Usuario o correo</span>
                  <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"
                    value="${recall('lah:username')}">
                </label>`
              : ''}
            ${passwordField('password', mode === 'admin' ? 'Contraseña de administración' : 'Contraseña', 'current-password')}
            <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar</button>
          </form>
          <p class="hint center">
            ${mode === 'admin'
              ? 'Acceso completo de la dirección: personal, ausencias, configuración y datos de la escuela.'
              : '¿Olvidaste tu contraseña? Pide a la dirección que la restablezca.'}
          </p>
        </div>
        <div data-install-slot></div>
        ${state.config?.platform_enabled ? html`<p class="auth-foot"><a href="#/platform">Panel de plataforma</a></p>` : ''}
      </div>`);

    for (const btn of el.querySelectorAll('[data-mode]')) {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        render();
      });
    }
    bindPasswordToggles(el);
    installHint($('[data-install-slot]', el), { dismissible: false });

    const form = $('[data-login]', el);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const submit = form.querySelector('[type=submit]');
      busy(submit, async () => {
        const v = formValues(form);
        if (!v.school_code || !v.password || (mode === 'staff' && !v.username)) {
          throw new Error('Completa todos los campos.');
        }
        const path = mode === 'admin' ? '/auth/admin-login' : '/auth/login';
        const me = await api(path, { method: 'POST', body: v });
        remember('lah:school', me.school.code);
        if (mode === 'staff') remember('lah:username', v.username.trim());
        state.me = me;
        state.platform = false;
        syncPush();
        go(me.user.must_change_password ? '/change-password' : homePath(), { replace: true });
      });
    });
  };
  render();
}

export async function changePasswordView({ el }) {
  const forced = state.me.user.must_change_password;
  el.innerHTML = String(html`
    <div class="auth">
      <div class="auth-brand">
        <img src="/icons/icon.svg" alt="" class="auth-logo" width="64" height="64">
        <h1>${forced ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1>
        <p>${forced
          ? `Hola, ${state.me.user.full_name}. Por seguridad, cambia la contraseña temporal que te dieron.`
          : 'Elige una contraseña nueva.'}</p>
      </div>
      <form class="card stack" data-form>
        ${passwordField('current_password', forced ? 'Contraseña temporal' : 'Contraseña actual', 'current-password')}
        ${passwordField('new_password', 'Nueva contraseña (mín. 8 caracteres)', 'new-password')}
        ${passwordField('confirm', 'Repite la nueva contraseña', 'new-password')}
        <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('key', 18)} Guardar contraseña</button>
        <button class="btn btn-ghost btn-block" type="button" data-leave>${forced ? 'Salir' : 'Volver'}</button>
      </form>
    </div>`);
  bindPasswordToggles(el);
  $('[data-leave]', el).addEventListener('click', () => (forced ? logout() : go(homePath())));
  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      if (v.new_password.length < 8) throw new Error('La nueva contraseña debe tener al menos 8 caracteres.');
      if (v.new_password !== v.confirm) throw new Error('Las contraseñas no coinciden.');
      await api('/me/password', { method: 'POST', body: v });
      state.me.user.must_change_password = false;
      toast('Contraseña actualizada', 'ok');
      go(homePath(), { replace: true });
    });
  });
}
