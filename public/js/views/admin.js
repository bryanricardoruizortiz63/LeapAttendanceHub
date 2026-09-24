import {
  $,
  ROLE_LABELS,
  addDays,
  api,
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
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { bindPasswordToggles } from './auth.js';
import { avatar, empty } from './common.js';

// ---- Credentials card ------------------------------------------------------

function credentialsText(employee, password) {
  return [
    'Leap Attendance Hub',
    `Enlace: ${location.origin}`,
    `Código de escuela: ${state.me.school.code}`,
    `Usuario: ${employee.username}`,
    `Contraseña temporal: ${password}`,
    'Al entrar te pedirá crear tu propia contraseña.',
  ].join('\n');
}

async function showCredentials(employee, password, title) {
  const text = credentialsText(employee, password);
  const body = html`
    <div class="credentials">
      <div><span>Código de escuela</span><strong>${state.me.school.code}</strong></div>
      <div><span>Usuario</span><strong>${employee.username}</strong></div>
      <div><span>Contraseña temporal</span><strong class="mono">${password}</strong></div>
    </div>
    <p class="hint">Compártelos con ${employee.full_name}. Esta contraseña no se volverá a mostrar.</p>
    <div class="button-row">
      <button type="button" class="btn btn-secondary btn-sm" data-copy>${icon('copy', 16)} Copiar</button>
      ${navigator.share ? html`<button type="button" class="btn btn-secondary btn-sm" data-share>${icon('share', 16)} Compartir</button>` : ''}
    </div>`;
  const pending = dialog({ title, body, confirmText: 'Listo', cancelText: '' });
  const dlg = document.querySelector('dialog.dialog:last-of-type');
  dlg.querySelector('[data-copy]').addEventListener('click', () => copyText(text));
  dlg.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ text }).catch(() => {}));
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
    employees = (await api('/employees?include_inactive=1')).employees;
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
  const employee = isNew ? { role: 'teacher', active: 1 } : (await api(`/employees/${params[0]}`)).employee;
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
            <a class="btn btn-secondary btn-block" href="#/absences?user_id=${employee.id}&status=all&from=">${icon('calendar', 18)} Ver sus ausencias</a>
            <a class="btn btn-secondary btn-block" href="#/report?user_id=${employee.id}">${icon('plus', 18)} Registrar una ausencia</a>
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
        const res = await api('/employees', { method: 'POST', body: v });
        await showCredentials(res.employee, res.temp_password, 'Empleado creado ✅');
        go('/employees', { replace: true });
      } else {
        if (self) {
          delete v.role;
          delete v.active;
        }
        await api(`/employees/${employee.id}`, { method: 'PATCH', body: v });
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
      const res = await api(`/employees/${employee.id}/reset-password`, { method: 'POST', body: {} });
      await showCredentials(employee, res.temp_password, 'Nueva contraseña temporal');
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
      await api(`/employees/${employee.id}`, { method: 'DELETE' });
      toast('Empleado eliminado', 'ok');
      go('/employees', { replace: true });
    });
  });
}

// ---- Escuela y Teams -----------------------------------------------------------

export async function settingsView({ el }) {
  let { school } = await api('/school');

  const teamsStatus = () => {
    if (!school.teams_webhook_url) return html`<p class="status-note muted">${icon('alert', 16)} Sin configurar</p>`;
    if (!school.teams_last_status) return html`<p class="status-note muted">${icon('clock', 16)} Aún no se ha enviado ningún mensaje</p>`;
    if (school.teams_last_status === 'ok') {
      return html`<p class="status-note ok">${icon('check', 16)} Último envío correcto · ${fmtDateTime(school.teams_last_at)}</p>`;
    }
    return html`<p class="status-note danger">${icon('alert', 16)} ${school.teams_last_status} · ${fmtDateTime(school.teams_last_at)}</p>`;
  };

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
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Guardar</button>
          <button class="btn btn-secondary" type="button" data-test>${icon('send', 16)} Enviar prueba</button>
        </div>
        <details class="help">
          <summary>¿Cómo obtengo la URL del webhook?</summary>
          <ol>
            <li>En Teams, ve al canal donde quieres recibir los avisos (por ejemplo “Dirección”).</li>
            <li>Toca <b>⋯</b> junto al nombre del canal y elige <b>Workflows</b> (Flujos de trabajo).</li>
            <li>Elige la plantilla <b>“Publicar en un canal cuando se reciba una solicitud de webhook”</b>
              (<i>Post to a channel when a webhook request is received</i>).</li>
            <li>Sigue los pasos, confirma el equipo y el canal, y copia la URL que te muestra al final.</li>
            <li>Pégala aquí, toca <b>Guardar</b> y luego <b>Enviar prueba</b>.</li>
          </ol>
          <p class="hint">Si tu organización todavía usa “Conectores → Incoming Webhook”, esa URL también funciona.</p>
        </details>
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
      ({ school } = await api('/school', { method: 'PATCH', body: { name: formValues(schoolForm).name } }));
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
      const v = formValues(teams);
      ({ school } = await api('/school', { method: 'PATCH', body: v }));
      refreshStatus();
      toast('Configuración de Teams guardada', 'ok');
    });
  });
  $('[data-test]', el).addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const v = formValues(teams);
      if ((v.teams_webhook_url || '') !== (school.teams_webhook_url || '')) {
        ({ school } = await api('/school', { method: 'PATCH', body: v }));
      }
      try {
        ({ school } = await api('/school/test-teams', { method: 'POST' }));
        toast('Mensaje de prueba enviado. Revisa tu canal de Teams.', 'ok');
      } finally {
        ({ school } = await api('/school'));
        refreshStatus();
      }
    }),
  );

  const pw = $('[data-admin-pw]', el);
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(pw.querySelector('[type=submit]'), async () => {
      await api('/school/admin-password', { method: 'POST', body: formValues(pw) });
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
        <p class="muted">Los archivos CSV se abren en Excel o Google Sheets.</p>
        <a class="btn btn-secondary btn-block" data-exp-range href="#">${icon('download', 18)} Ausencias del período (CSV)</a>
        <a class="btn btn-secondary btn-block" href="/api/data/export/absences.csv">${icon('download', 18)} Todas las ausencias (CSV)</a>
        <a class="btn btn-secondary btn-block" href="/api/data/export/employees.csv">${icon('download', 18)} Lista de personal (CSV)</a>
        <a class="btn btn-ghost btn-block" href="/api/data/export/backup.json">${icon('shield', 18)} Respaldo completo (JSON)</a>
      </section>
    </div>`);

  const fromInput = $('[data-from]', el);
  const toInput = $('[data-to]', el);

  async function load() {
    const qs = new URLSearchParams({ from: range.from, to: range.to });
    $('[data-exp-range]', el).href = `/api/data/export/absences.csv?${qs}`;
    const s = await api(`/data/stats?${qs}`);
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
  await load();
}
