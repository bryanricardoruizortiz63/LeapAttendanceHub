import {
  $,
  ROLE_LABELS,
  addDays,
  busy,
  copyText,
  dialog,
  fmtDateTime,
  formValues,
  html,
  timeAgo,
  toast,
  todayStr,
} from '../lib.js';
import {
  createEmployee,
  deleteEmployee,
  exportAbsencesXlsx,
  exportBackupJson,
  exportEmployeesXlsx,
  getEmployee,
  getSchool,
  listEmployees,
  removeEmailAccount,
  resetEmployeePassword,
  saveEmailAccount,
  saveWelcomeTemplate,
  sendCredentials,
  setAdminPassword,
  stats,
  testEmail,
  testTeams,
  updateEmployee,
  updateSchool,
} from '../backend.js';
import { APP_URL } from '../config.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { bindPasswordToggles } from './auth.js';
import { archiveSection } from './archive.js';
import { avatar, empty } from './common.js';

/** Asked for a new password from the login screen in the last 3 days. */
function recentHelp(e) {
  return !!e.password_help_at && Date.now() - new Date(e.password_help_at).getTime() < 3 * 86400000;
}

// ---- Credentials card ------------------------------------------------------

/** The school's welcome text (Escuela y Teams → Mensaje con usuario y contraseña) filled in for one person. */
function renderWelcome(school, employee, password) {
  const vars = {
    nombre: employee.full_name,
    usuario: employee.username,
    'contraseña': password,
    contrasena: password,
    escuela: school.name,
    codigo: school.code,
    enlace: `${APP_URL}?escuela=${encodeURIComponent(school.code)}`,
  };
  const fill = (t) => String(t || '').replace(/\{([a-zñáéíóú]+)\}/gi, (m, k) => vars[k.toLowerCase()] ?? m);
  return { subject: fill(school.welcome_subject), text: fill(school.welcome_body) };
}

function emailSlot(school, employee) {
  if (!employee.email) return html`<p class="hint">Añade su correo en la ficha para poder enviárselo por correo.</p>`;
  if (!school.email_provider) {
    return html`<p class="hint">Para enviarlo por correo, conecta una cuenta en <b>Más → Escuela y Teams → Correo electrónico</b>.</p>`;
  }
  return html`<button type="button" class="btn btn-primary btn-block" data-send-email>${icon('mail', 18)} Enviar por correo a ${employee.email}</button>`;
}

async function showCredentials(employee, password, title, school) {
  const { text } = renderWelcome(school, employee, password);
  const body = html`
    <div class="credentials">
      <div><span>Código de escuela</span><strong>${school.code}</strong></div>
      <div><span>Usuario</span><strong>${employee.username}</strong></div>
      <div><span>Contraseña temporal</span><strong class="mono">${password}</strong></div>
    </div>
    <p class="hint">Envíaselos a ${employee.full_name} con las instrucciones. Esta contraseña no se volverá a mostrar.</p>
    <div data-email-slot>${emailSlot(school, employee)}</div>
    <div class="button-row">
      <button type="button" class="btn btn-secondary btn-sm" data-copy>${icon('copy', 16)} Copiar mensaje</button>
      ${navigator.share ? html`<button type="button" class="btn btn-secondary btn-sm" data-share>${icon('share', 16)} Compartir</button>` : ''}
    </div>`;
  const pending = dialog({ title, body, confirmText: 'Listo', cancelText: '' });
  const dlg = document.querySelector('dialog.dialog:last-of-type');
  dlg.querySelector('[data-copy]').addEventListener('click', () => copyText(text));
  dlg.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ text }).catch(() => {}));
  const send = dlg.querySelector('[data-send-email]');
  send?.addEventListener('click', () =>
    busy(send, async () => {
      const res = await sendCredentials(employee.id, password);
      dlg.querySelector('[data-email-slot]').innerHTML = String(
        html`<p class="status-note ok">${icon('check', 16)} Enviado a ${res.to}</p>`,
      );
      toast('Correo enviado', 'ok');
    }),
  );
  return pending;
}

// ---- Personal ----------------------------------------------------------------

export async function employeesView({ el }) {
  let showInactive = false;
  let employees = [];
  let q = '';

  const renderList = () => {
    const needle = q.toLowerCase();
    const rows = employees.filter(
      (e) =>
        (showInactive || e.active) &&
        (!needle || `${e.full_name} ${e.position || ''} ${e.username}`.toLowerCase().includes(needle)),
    );
    $('[data-list]', el).innerHTML = String(
      rows.length
        ? html`<div class="list">${rows.map(
            (e) => html`<a class="item ${e.active ? '' : 'is-muted'}" href="#/employees/${e.id}">
              ${avatar(e.full_name)}
              <span class="item-main">
                <strong>${e.full_name}</strong>
                <span class="item-sub">${[e.position, e.username].filter(Boolean).join(' · ')}</span>
                <span class="item-tags">
                  <span class="tag">${e.role_label}</span>
                  ${e.absence_count ? html`<span class="tag">${icon('calendar', 14)} ${e.absence_count}</span>` : ''}
                  ${e.active ? '' : html`<span class="tag tag-warn">Inactivo</span>`}
                  ${e.active && !e.last_login_at ? html`<span class="tag">Nunca ha entrado</span>` : ''}
                  ${recentHelp(e) ? html`<span class="tag tag-warn">${icon('key', 14)} Pidió contraseña</span>` : ''}
                </span>
              </span>
              ${icon('chevron', 18)}
            </a>`,
          )}</div>`
        : empty('users', employees.length ? 'Sin resultados' : 'Aún no hay personal', employees.length ? '' : 'Añade a tus maestros y personal para que puedan reportar ausencias.'),
    );
    $('[data-total]', el).textContent = `${employees.filter((e) => e.active).length} activos`;
  };

  const load = async () => {
    employees = await listEmployees();
    renderList();
  };

  el.innerHTML = String(html`
    <div class="toolbar">
      <label class="search grow">${icon('search', 18)}<input type="search" placeholder="Buscar por nombre o puesto…" data-q></label>
      <a class="btn btn-primary" href="#/employees/new">${icon('plus', 18)} Nuevo</a>
    </div>
    <div class="list-head">
      <p class="muted" data-total></p>
      <label class="switch-inline"><input type="checkbox" data-inactive> Mostrar inactivos</label>
    </div>
    <div data-list><div class="loading"><span class="spinner"></span></div></div>`);

  $('[data-q]', el).addEventListener('input', (e) => {
    q = e.target.value.trim();
    renderList();
  });
  $('[data-inactive]', el).addEventListener('change', (e) => {
    showInactive = e.target.checked;
    renderList();
  });
  await load();
}

export async function employeeFormView({ el, params, setTitle }) {
  const isNew = params[0] === 'new';
  const me = state.me.user;
  const [employee, school] = await Promise.all([
    isNew ? { role: 'teacher', active: true } : getEmployee(params[0]),
    getSchool(state.me.school.id),
  ]);
  const self = employee.id === me.id;
  setTitle(isNew ? 'Nuevo empleado' : employee.full_name);

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      <section class="card stack">
        <h2 class="card-title">${icon('user')} Datos del empleado</h2>
        <label class="field"><span>Nombre completo</span>
          <input name="full_name" required maxlength="120" value="${employee.full_name || ''}" autocomplete="off"></label>
        <label class="field"><span>Puesto / grado / materia</span>
          <input name="position" maxlength="120" value="${employee.position || ''}" placeholder="Ej. Maestra de 3er grado"></label>
        <div class="grid2">
          <label class="field"><span>Correo</span>
            <input name="email" type="email" maxlength="200" value="${employee.email || ''}" autocapitalize="none"></label>
          <label class="field"><span>Teléfono</span>
            <input name="phone" type="tel" maxlength="40" value="${employee.phone || ''}"></label>
        </div>
        <label class="field"><span>Número de empleado <em class="optional">opcional</em></span>
          <input name="employee_number" maxlength="40" value="${employee.employee_number || ''}"></label>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('key')} Acceso</h2>
        <label class="field"><span>Usuario para entrar</span>
          <input name="username" maxlength="100" value="${employee.username || ''}" autocapitalize="none" spellcheck="false"
            placeholder="${isNew ? 'Si lo dejas vacío se usa el correo' : ''}"></label>
        <label class="field"><span>Rol</span>
          <select name="role" ${self ? 'disabled' : ''}>
            ${['teacher', 'secretary', 'director'].map(
              (r) => html`<option value="${r}" ${employee.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`,
            )}
          </select>
        </label>
        <p class="hint">
          <b>Maestro(a):</b> reporta sus ausencias. <b>Secretaría:</b> además ve y confirma las ausencias de todos.
          <b>Director(a):</b> acceso completo, incluido personal, configuración y datos.
        </p>
        ${isNew
          ? html`<label class="field"><span>Contraseña temporal <em class="optional">opcional</em></span>
              <span class="pw"><input name="password" type="password" minlength="8" autocomplete="new-password"
                placeholder="Vacía = se genera automáticamente"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>`
          : html`<label class="toggle"><input type="checkbox" name="active" ${employee.active ? 'checked' : ''} ${self ? 'disabled' : ''}>
              <span class="toggle-ui"></span><span>Cuenta activa</span></label>
              <p class="hint">Último acceso: ${employee.last_login_at ? timeAgo(employee.last_login_at) : 'nunca'}</p>`}
      </section>

      <button class="btn btn-primary btn-block btn-lg" type="submit">${isNew ? html`${icon('plus')} Crear empleado` : 'Guardar cambios'}</button>

      ${isNew
        ? ''
        : html`<section class="card stack">
            ${recentHelp(employee)
              ? html`<p class="status-note warn">${icon('key', 16)} Pidió ayuda con su contraseña ${timeAgo(employee.password_help_at)}.
                  Toca “Restablecer contraseña” y compártele la temporal.</p>`
              : ''}
            <a class="btn btn-secondary btn-block" href="#/absences?user_id=${employee.id}&status=all&from=">${icon('calendar', 18)} Ver sus ausencias</a>
            ${self ? '' : html`<a class="btn btn-secondary btn-block" href="#/messages/new?to=${employee.id}">${icon('mail', 18)} Enviar mensaje</a>`}
            ${me.role === 'admin'
              ? html`<a class="btn btn-secondary btn-block" href="#/report?user_id=${employee.id}">${icon('plus', 18)} Registrar una ausencia</a>`
              : ''}
            <button type="button" class="btn btn-secondary btn-block" data-reset>${icon('key', 18)} Restablecer contraseña</button>
            ${self ? '' : html`<button type="button" class="btn btn-ghost-danger btn-block" data-delete>${icon('trash', 18)} Eliminar empleado</button>`}
          </section>`}
    </form>`);

  bindPasswordToggles(el);
  const form = $('[data-form]', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      if (!v.full_name.trim()) throw new Error('Escribe el nombre del empleado.');
      if (isNew) {
        if (!v.username.trim() && !v.email.trim()) throw new Error('Escribe un usuario o un correo.');
        if (!v.password) delete v.password;
        const res = await createEmployee(v);
        await showCredentials(res.employee, res.temp_password, 'Empleado creado ✅', school);
        go('/employees', { replace: true });
      } else {
        if (self) {
          delete v.role;
          delete v.active;
        }
        await updateEmployee(employee.id, v);
        toast('Cambios guardados', 'ok');
        go('/employees');
      }
    });
  });

  $('[data-reset]', el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await dialog({
      title: '¿Restablecer contraseña?',
      message: `Se generará una contraseña temporal para ${employee.full_name} y se cerrará su sesión en todos sus dispositivos.`,
      confirmText: 'Restablecer',
    });
    if (!ok) return;
    await busy(btn, async () => {
      const res = await resetEmployeePassword(employee.id);
      await showCredentials(employee, res.temp_password, 'Nueva contraseña temporal', school);
    });
  });

  $('[data-delete]', el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await dialog({
      title: `¿Eliminar a ${employee.full_name}?`,
      message: 'Solo se puede eliminar si no tiene ausencias registradas. Si ya tiene historial, desactiva la cuenta.',
      confirmText: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    await busy(btn, async () => {
      await deleteEmployee(employee.id);
      toast('Empleado eliminado', 'ok');
      go('/employees', { replace: true });
    });
  });
}

// ---- Escuela y Teams -----------------------------------------------------------

export async function settingsView({ el, reload }) {
  let school = await getSchool(state.me.school.id);

  const teamsStatus = () => {
    if (!school.teams_webhook_url) return html`<p class="status-note muted">${icon('alert', 16)} Sin configurar</p>`;
    if (!school.teams_last_status) return html`<p class="status-note muted">${icon('clock', 16)} Aún no se ha enviado ningún mensaje</p>`;
    if (school.teams_last_status === 'ok') {
      return html`<p class="status-note ok">${icon('check', 16)} Último envío correcto · ${fmtDateTime(school.teams_last_at)}</p>`;
    }
    return html`<p class="status-note danger">${icon('alert', 16)} ${school.teams_last_status} · ${fmtDateTime(school.teams_last_at)}</p>`;
  };

  const emailStatus = () => {
    if (!school.email_provider) return html`<p class="status-note muted">${icon('alert', 16)} Sin configurar</p>`;
    if (!school.email_last_status) {
      return html`<p class="status-note muted">${icon('mail', 16)} Conectado: ${school.email_from} · aún no se ha enviado nada</p>`;
    }
    if (school.email_last_status === 'ok') {
      return html`<p class="status-note ok">${icon('check', 16)} Conectado: ${school.email_from} · último envío correcto ${fmtDateTime(school.email_last_at)}</p>`;
    }
    return html`<p class="status-note danger">${icon('alert', 16)} ${school.email_last_status.replace(/^error: /, '')} · ${fmtDateTime(school.email_last_at)}</p>`;
  };
  const gmail = school.email_provider !== 'smtp';

  el.innerHTML = String(html`
    <div class="stack">
      <form class="card stack" data-school>
        <h2 class="card-title">${icon('school')} Escuela</h2>
        <label class="field"><span>Nombre</span><input name="name" required maxlength="150" value="${school.name}"></label>
        <div class="field"><span>Código de escuela</span>
          <div class="code-box"><strong class="mono">${school.code}</strong>
            <button type="button" class="btn btn-ghost btn-sm" data-copy-code>${icon('copy', 16)} Copiar</button></div>
          <small class="hint">El personal usa este código para entrar. La dirección entra con el código y la contraseña de administración.</small>
        </div>
        <button class="btn btn-secondary" type="submit">Guardar</button>
      </form>

      <form class="card stack" data-teams>
        <h2 class="card-title">${icon('teams')} Notificaciones en Microsoft Teams</h2>
        <p class="muted">Cada nueva ausencia se publicará en el canal de Teams que elijas (por ejemplo, el canal de la dirección).</p>
        <label class="toggle"><input type="checkbox" name="teams_enabled" ${school.teams_enabled ? 'checked' : ''}>
          <span class="toggle-ui"></span><span>Enviar avisos a Teams</span></label>
        <label class="toggle"><input type="checkbox" name="teams_include_reason" ${school.teams_include_reason ? 'checked' : ''}>
          <span class="toggle-ui"></span><span>Incluir la causa de la ausencia en el mensaje</span></label>
        <label class="field"><span>URL del webhook de Teams</span>
          <input name="teams_webhook_url" type="url" value="${school.teams_webhook_url || ''}" autocapitalize="none" spellcheck="false"
            placeholder="https://…logic.azure.com/… o https://…webhook.office.com/…"></label>
        <div data-teams-status>${teamsStatus()}</div>
        <label class="field"><span>URL para “Olvidé mi contraseña” <em class="optional">opcional</em></span>
          <input name="teams_password_webhook_url" type="url" value="${school.teams_password_webhook_url || ''}" autocapitalize="none"
            spellcheck="false" placeholder="Vacía = mismo canal de las ausencias"></label>
        <p class="hint">Cuando alguien toca “¿Olvidaste tu contraseña?”, avisamos aquí, en la app y en el teléfono de la dirección.
          Si quieres esos avisos en otro chat o canal, crea otro webhook allí y pega su URL.</p>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Guardar</button>
          <button class="btn btn-secondary" type="button" data-test="main">${icon('send', 16)} Probar ausencias</button>
          <button class="btn btn-secondary" type="button" data-test="password">${icon('send', 16)} Probar contraseñas</button>
        </div>
        <details class="help">
          <summary>¿Cómo obtengo la URL del webhook?</summary>
          <ol>
            <li>En Teams, ve al canal donde quieres recibir los avisos (por ejemplo “Dirección”).</li>
            <li>Toca <b>⋯</b> junto al nombre del canal y elige <b>Workflows</b> (Flujos de trabajo).</li>
            <li>Elige la plantilla <b>“Publicar en un canal cuando se reciba una solicitud de webhook”</b>
              (<i>Post to a channel when a webhook request is received</i>).</li>
            <li>Sigue los pasos, confirma el equipo y el canal, y copia la URL que te muestra al final.</li>
            <li>Pégala aquí, toca <b>Guardar</b> y luego <b>Probar ausencias</b>.</li>
          </ol>
          <p class="hint">Si tu organización todavía usa “Conectores → Incoming Webhook”, esa URL también funciona.</p>
        </details>
      </form>

      <form class="card stack" data-email novalidate>
        <h2 class="card-title">${icon('mail')} Correo electrónico</h2>
        <p class="muted">Conecta una cuenta para enviar a cada persona su usuario y contraseña, y tus mensajes por correo.</p>
        <div data-email-status>${emailStatus()}</div>
        <div class="segmented" role="radiogroup" aria-label="Tipo de cuenta">
          <label class="seg"><input type="radio" name="provider" value="gmail" ${gmail ? 'checked' : ''}> Gmail</label>
          <label class="seg"><input type="radio" name="provider" value="smtp" ${gmail ? '' : 'checked'}> Otro (SMTP)</label>
        </div>
        <label class="field"><span>Correo que envía</span>
          <input name="from_email" type="email" maxlength="200" value="${school.email_from || ''}" autocapitalize="none" spellcheck="false"
            placeholder="ej. asistencia.leap@gmail.com"></label>
        <label class="field"><span>Nombre que verán <em class="optional">opcional</em></span>
          <input name="from_name" maxlength="100" value="${school.email_from_name || ''}" placeholder="${school.name}"></label>
        <div class="stack" data-smtp ${gmail ? 'hidden' : ''}>
          <div class="grid2">
            <label class="field"><span>Servidor SMTP</span>
              <input name="smtp_host" maxlength="253" value="${school.email_provider === 'smtp' ? school.smtp_host || '' : ''}" autocapitalize="none"
                spellcheck="false" placeholder="smtp-relay.brevo.com"></label>
            <label class="field"><span>Puerto</span>
              <input name="smtp_port" type="number" min="1" max="65535" value="${school.email_provider === 'smtp' ? school.smtp_port || 465 : 465}"></label>
          </div>
          <label class="field"><span>Usuario SMTP <em class="optional">vacío = el correo que envía</em></span>
            <input name="smtp_user" maxlength="200" value="${school.email_provider === 'smtp' && school.smtp_user !== school.email_from ? school.smtp_user || '' : ''}"
              autocapitalize="none" spellcheck="false"></label>
          <p class="hint">Usa el puerto 465 (SSL) o el 2525. Supabase bloquea el 25 y el 587, así que Outlook / Microsoft 365 no sirven.</p>
        </div>
        <label class="field"><span data-pw-label>${gmail ? 'Contraseña de aplicación de Google' : 'Contraseña o clave SMTP'}</span>
          <span class="pw"><input name="password" type="password" maxlength="500" autocomplete="new-password"
            placeholder="${school.email_provider ? 'Guardada · escribe otra solo para cambiarla' : ''}"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Guardar</button>
          <button class="btn btn-secondary" type="button" data-test-email ${school.email_provider ? '' : 'disabled'}>${icon('send', 16)} Enviar prueba</button>
          ${school.email_provider ? html`<button class="btn btn-ghost-danger" type="button" data-remove-email>Desconectar</button>` : ''}
        </div>
        <details class="help">
          <summary>¿Cómo conecto una cuenta de Gmail?</summary>
          <ol>
            <li>Usa una cuenta de Gmail para la escuela (puedes crear una solo para esto, por ejemplo <i>asistencia.tuescuela@gmail.com</i>).</li>
            <li>Activa la <b>verificación en 2 pasos</b> en <a href="https://myaccount.google.com/security" target="_blank" rel="noopener">myaccount.google.com/security</a>.</li>
            <li>Entra a <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>,
              escribe “Leap Attendance Hub” y toca <b>Crear</b>.</li>
            <li>Copia la contraseña de 16 letras, pégala aquí con el correo y toca <b>Guardar</b>. Luego <b>Enviar prueba</b>.</li>
          </ol>
          <p class="hint">Gmail permite unos 500 correos al día. La contraseña se guarda cifrada y nadie puede verla, ni siquiera desde la app.</p>
        </details>
      </form>

      <form class="card stack" data-welcome novalidate>
        <h2 class="card-title">${icon('key')} Mensaje con usuario y contraseña</h2>
        <p class="muted">Lo recibe cada persona por correo (y es el texto que se copia o comparte) cuando creas su cuenta o restableces su contraseña.</p>
        <label class="field"><span>Asunto</span>
          <input name="subject" maxlength="200" value="${school.welcome_subject || ''}"></label>
        <label class="field"><span>Mensaje</span>
          <textarea name="body" rows="16" maxlength="5000">${school.welcome_body || ''}</textarea></label>
        <div class="placeholders">
          <span class="hint">Toca para insertar:</span>
          ${['{nombre}', '{usuario}', '{contraseña}', '{enlace}', '{escuela}', '{codigo}'].map(
            (p) => html`<button type="button" class="chip-btn" data-insert="${p}">${p}</button>`,
          )}
        </div>
        <p class="hint">{enlace} abre la app con el código de la escuela ya puesto. {usuario} y {contraseña} son obligatorios.</p>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Guardar</button>
          <button class="btn btn-secondary" type="button" data-preview>Vista previa</button>
          <button class="btn btn-ghost" type="button" data-restore>Restaurar texto original</button>
        </div>
      </form>

      <form class="card stack" data-admin-pw>
        <h2 class="card-title">${icon('shield')} Contraseña de administración</h2>
        <p class="muted">Es la contraseña que se usa junto al código de escuela en la pestaña “Administración”. Dásela solo a la dirección.</p>
        <label class="field"><span>Contraseña actual de administración</span>
          <span class="pw"><input name="current_password" type="password" required autocomplete="off"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <label class="field"><span>Nueva contraseña (mín. 8)</span>
          <span class="pw"><input name="new_password" type="password" required minlength="8" autocomplete="new-password"><button type="button" class="pw-toggle" data-pw>Ver</button></span></label>
        <button class="btn btn-secondary" type="submit">Cambiar contraseña</button>
      </form>

      <a class="card link-card" href="#/data">${icon('chart')}<span><strong>Datos y reportes</strong><small>Estadísticas, exportar a Excel y respaldo</small></span>${icon('chevron', 18)}</a>
    </div>`);

  bindPasswordToggles(el);
  $('[data-copy-code]', el).addEventListener('click', () => copyText(school.code));

  const schoolForm = $('[data-school]', el);
  schoolForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(schoolForm.querySelector('[type=submit]'), async () => {
      await updateSchool({ name: formValues(schoolForm).name });
      school = await getSchool(state.me.school.id);
      state.me.school.name = school.name;
      toast('Escuela actualizada', 'ok');
    });
  });

  const teams = $('[data-teams]', el);
  const refreshStatus = () => {
    $('[data-teams-status]', el).innerHTML = String(teamsStatus());
  };
  teams.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(teams.querySelector('[type=submit]'), async () => {
      await updateSchool(formValues(teams));
      school = await getSchool(state.me.school.id);
      refreshStatus();
      toast('Configuración de Teams guardada', 'ok');
    });
  });
  for (const btn of el.querySelectorAll('[data-test]')) {
    btn.addEventListener('click', () =>
      busy(btn, async () => {
        const v = formValues(teams);
        const changed =
          (v.teams_webhook_url || '') !== (school.teams_webhook_url || '') ||
          (v.teams_password_webhook_url || '') !== (school.teams_password_webhook_url || '');
        if (changed) await updateSchool(v);
        try {
          await testTeams(btn.dataset.test);
          toast('Mensaje de prueba enviado. Revisa tu canal de Teams.', 'ok');
        } finally {
          school = await getSchool(state.me.school.id);
          refreshStatus();
        }
      }),
    );
  }

  // ---- Correo electrónico
  const emailForm = $('[data-email]', el);
  const refreshEmail = async () => {
    school = await getSchool(state.me.school.id);
    $('[data-email-status]', el).innerHTML = String(emailStatus());
  };
  const syncProvider = () => {
    const smtp = emailForm.querySelector('[name=provider]:checked').value === 'smtp';
    $('[data-smtp]', emailForm).hidden = !smtp;
    $('[data-pw-label]', emailForm).textContent = smtp ? 'Contraseña o clave SMTP' : 'Contraseña de aplicación de Google';
    for (const seg of emailForm.querySelectorAll('.seg')) seg.classList.toggle('active', seg.querySelector('input').checked);
  };
  for (const r of emailForm.querySelectorAll('[name=provider]')) r.addEventListener('change', syncProvider);
  syncProvider();
  const saveEmail = async () => {
    const v = formValues(emailForm);
    if (!v.from_email.trim()) throw new Error('Escribe el correo que envía.');
    if (!school.email_provider && !v.password) throw new Error('Escribe la contraseña de aplicación.');
    await saveEmailAccount(v);
    emailForm.password.value = '';
  };
  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(emailForm.querySelector('[type=submit]'), async () => {
      await saveEmail();
      toast('Correo conectado. Toca “Enviar prueba” para comprobarlo.', 'ok');
      reload();
    });
  });
  $('[data-test-email]', el).addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      if (emailForm.password.value) await saveEmail();
      try {
        const res = await testEmail();
        toast(`Correo de prueba enviado a ${res.to}. Revisa la bandeja de entrada.`, 'ok');
      } finally {
        await refreshEmail();
      }
    }),
  );
  $('[data-remove-email]', el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await dialog({
      title: '¿Desconectar el correo?',
      message: 'La app dejará de enviar correos hasta que conectes otra cuenta. Se borra la contraseña guardada.',
      confirmText: 'Desconectar',
      danger: true,
    });
    if (!ok) return;
    await busy(btn, async () => {
      await removeEmailAccount();
      toast('Correo desconectado', 'ok');
      reload();
    });
  });

  // ---- Mensaje con usuario y contraseña
  const welcome = $('[data-welcome]', el);
  for (const chip of welcome.querySelectorAll('[data-insert]')) {
    chip.addEventListener('click', () => {
      const ta = welcome.body;
      const start = ta.selectionStart ?? ta.value.length;
      ta.setRangeText(chip.dataset.insert, start, ta.selectionEnd ?? start, 'end');
      ta.focus();
    });
  }
  welcome.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(welcome.querySelector('[type=submit]'), async () => {
      const v = formValues(welcome);
      if (!v.body.includes('{usuario}') || !v.body.includes('{contraseña}')) {
        throw new Error('El mensaje debe incluir {usuario} y {contraseña}.');
      }
      await saveWelcomeTemplate(v.subject, v.body);
      school = await getSchool(state.me.school.id);
      toast('Mensaje guardado', 'ok');
    });
  });
  $('[data-preview]', el).addEventListener('click', () => {
    const v = formValues(welcome);
    const sample = { full_name: 'María González', username: 'maria.gonzalez' };
    const out = renderWelcome({ ...school, welcome_subject: v.subject, welcome_body: v.body }, sample, 'Kp7mWq2xTz');
    dialog({
      title: 'Vista previa',
      body: html`<p><b>Asunto:</b> ${out.subject}</p><div class="preview-box pre">${out.text}</div>`,
      confirmText: 'Cerrar',
      cancelText: '',
    });
  });
  $('[data-restore]', el).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await dialog({ title: '¿Restaurar el texto original?', message: 'Se perderán tus cambios al mensaje.', confirmText: 'Restaurar' });
    if (!ok) return;
    await busy(btn, async () => {
      await saveWelcomeTemplate(null, null);
      reload();
      toast('Texto original restaurado', 'ok');
    });
  });

  const pw = $('[data-admin-pw]', el);
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(pw.querySelector('[type=submit]'), async () => {
      const v = formValues(pw);
      await setAdminPassword(v.current_password, v.new_password);
      pw.reset();
      toast('Contraseña de administración actualizada', 'ok');
    });
  });
}

// ---- Datos y reportes ------------------------------------------------------------

function schoolYearStart(today) {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 8 ? y : y - 1}-08-01`;
}

export async function dataView({ el, isCurrent }) {
  const today = todayStr();
  const presets = {
    '30': { label: '30 días', from: addDays(today, -30), to: today },
    month: { label: 'Este mes', from: `${today.slice(0, 8)}01`, to: today },
    year: { label: 'Año escolar', from: schoolYearStart(today), to: today },
  };
  let range = { ...presets['30'] };

  el.innerHTML = String(html`
    <div class="stack">
      <section class="card stack">
        <div class="quick">
          ${Object.entries(presets).map(
            ([k, p]) => html`<button type="button" class="chip-btn ${k === '30' ? 'active' : ''}" data-preset="${k}">${p.label}</button>`,
          )}
        </div>
        <div class="grid2">
          <label class="field"><span>Desde</span><input type="date" data-from value="${range.from}"></label>
          <label class="field"><span>Hasta</span><input type="date" data-to value="${range.to}"></label>
        </div>
      </section>
      <div data-stats><div class="loading"><span class="spinner"></span></div></div>
      <section class="card stack">
        <h2 class="card-title">${icon('download')} Exportar datos de la escuela</h2>
        <p class="muted">Archivos de Excel (también abren en Google Sheets y Numbers).</p>
        <button type="button" class="btn btn-secondary btn-block" data-export="range">${icon('download', 18)} Ausencias del período (Excel)</button>
        <button type="button" class="btn btn-secondary btn-block" data-export="all">${icon('download', 18)} Todas las ausencias (Excel)</button>
        <button type="button" class="btn btn-secondary btn-block" data-export="employees">${icon('download', 18)} Lista de personal (Excel)</button>
        <button type="button" class="btn btn-ghost btn-block" data-export="backup">${icon('shield', 18)} Respaldo completo (JSON)</button>
      </section>
      <div data-archive-slot></div>
    </div>`);

  const fromInput = $('[data-from]', el);
  const toInput = $('[data-to]', el);
  const { school } = state.me;
  const exporters = {
    range: () => exportAbsencesXlsx(school.code, range),
    all: () => exportAbsencesXlsx(school.code),
    employees: () => exportEmployeesXlsx(school.code),
    backup: () => exportBackupJson(school),
  };
  for (const btn of el.querySelectorAll('[data-export]')) {
    btn.addEventListener('click', () => busy(btn, exporters[btn.dataset.export]));
  }

  async function load() {
    const s = await stats(range.from, range.to);
    if (!isCurrent()) return;
    const maxCat = Math.max(1, ...s.by_category.map((c) => c.count));
    const maxDays = Math.max(1, ...s.by_employee.map((e) => e.days));
    $('[data-stats]', el).innerHTML = String(html`
      <div class="stats">
        <div class="stat"><strong>${s.totals.absences}</strong><span>Ausencias</span></div>
        <div class="stat"><strong>${s.totals.days}</strong><span>Días laborables</span></div>
        <div class="stat"><strong>${s.totals.employees}</strong><span>Empleados</span></div>
        <div class="stat ${s.totals.pending ? 'stat-warn' : ''}"><strong>${s.totals.pending}</strong><span>Por confirmar</span></div>
      </div>
      ${s.totals.absences
        ? html`
          <section class="card stack">
            <h2 class="card-title">${icon('chart')} Por tipo</h2>
            <div class="bars">${s.by_category.map(
              (c) => html`<div class="bar-row"><span>${c.label}</span>
                <span class="bar"><i data-w="${(c.count / maxCat) * 100}"></i></span><b>${c.count}</b></div>`,
            )}</div>
          </section>
          <section class="card stack">
            <h2 class="card-title">${icon('users')} Por empleado</h2>
            <div class="bars">${s.by_employee.map(
              (e) => html`<a class="bar-row" href="#/absences?user_id=${e.user_id}&from=${range.from}&to=${range.to}&status=active">
                <span>${e.full_name}<small>${e.count} ausencia${e.count === 1 ? '' : 's'}</small></span>
                <span class="bar"><i data-w="${(e.days / maxDays) * 100}"></i></span><b>${e.days} d</b></a>`,
            )}</div>
          </section>`
        : html`<div class="card">${empty('chart', 'Sin ausencias en este período')}</div>`}`);
    for (const bar of el.querySelectorAll('.bar i')) bar.style.width = `${Math.max(3, Number(bar.dataset.w))}%`;
  }

  for (const btn of el.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      range = { ...presets[btn.dataset.preset] };
      fromInput.value = range.from;
      toInput.value = range.to;
      for (const b of el.querySelectorAll('[data-preset]')) b.classList.toggle('active', b === btn);
      load();
    });
  }
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      if (!fromInput.value || !toInput.value) return;
      range = { from: fromInput.value, to: toInput.value };
      for (const b of el.querySelectorAll('[data-preset]')) b.classList.remove('active');
      load();
    });
  }
  archiveSection($('[data-archive-slot]', el)).catch((err) => toast(err.message, 'error'));
  await load();
}
