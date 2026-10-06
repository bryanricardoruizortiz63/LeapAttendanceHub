// ---- Safe HTML templating ---------------------------------------------------

class Safe {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export const raw = (value) => new Safe(String(value));

function part(value) {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/** Tagged template: interpolated values are escaped unless wrapped with raw() or nested html``. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Labels -----------------------------------------------------------------

export const CATEGORIES = {
  enfermedad: 'Enfermedad',
  cita_medica: 'Cita médica',
  personal: 'Asunto personal',
  familiar: 'Emergencia familiar',
  oficial: 'Capacitación / oficial',
  otro: 'Otro',
};

export const STATUS = {
  pending: { label: 'Enviada', cls: 'badge-warn' },
  received: { label: 'Recibida', cls: 'badge-ok' },
  cancelled: { label: 'Cancelada', cls: 'badge-muted' },
};

/** Names for when the school's roles aren't loaded (and for roles deleted since). */
export const ROLE_LABELS = {
  admin: 'Administración',
  director: 'Director(a)',
  secretary: 'Secretaría',
  teacher: 'Maestro(a)',
};

/** What a role can do besides reporting its own absences. */
export const PERMISSIONS = [
  { key: 'absences', label: 'Ver y confirmar las ausencias de todos', hint: 'Panel, lista de ausencias, marcar como recibidas, cobertura y avisos de ausencias nuevas.' },
  { key: 'staff', label: 'Administrar el personal', hint: 'Crear y editar empleados, contraseñas y enviar accesos por correo.' },
  { key: 'calendar', label: 'Calendario escolar', hint: 'Horario de clases, días sin clases y los grados y grupos de la escuela.' },
  { key: 'security', label: 'Seguridad', hint: 'Recibe las alertas de «No ha llegado» enviadas a Seguridad y se encarga de las salidas de estudiantes.' },
  { key: 'maintenance', label: 'Mantenimiento', hint: 'Recibe las solicitudes de mantenimiento (derrames, limpieza, baños, reparaciones) y las atiende.' },
  { key: 'messages', label: 'Enviar mensajes', hint: 'Escribir a todo el personal o a grupos.' },
  { key: 'reports', label: 'Datos y reportes', hint: 'Estadísticas, exportar a Excel, respaldo y archivo anual.' },
  { key: 'settings', label: 'Configurar la escuela', hint: 'Nombre, Teams, correo y mensaje de bienvenida.' },
];

/** Duties rather than powers over other people's data: whoever manages the staff can give a role with them. */
export const DUTIES = ['maintenance'];

// The school's roles ({ key, name, permissions, coverage }), from me().
let schoolRoles = [];
export function setSchoolRoles(list) {
  schoolRoles = Array.isArray(list) ? list : [];
}
export const getSchoolRoles = () => schoolRoles;
const findRole = (key) => schoolRoles.find((r) => r.key === key);
export const roleLabel = (key) => findRole(key)?.name || ROLE_LABELS[key] || '';
/** Absences of this role need someone to cover them (teachers); nursing or maintenance don't. */
export const roleNeedsCoverage = (key) => findRole(key)?.coverage ?? key !== 'admin';

/** Whether this user may do something (the Administración account can do everything). */
export const can = (u, perm) => u?.role === 'admin' || !!u?.permissions?.includes(perm);
/** Sees and confirms everyone's absences. */
export const isStaff = (u) => can(u, 'absences');
/** Has some management permission. */
export const isManager = (u) => ['staff', 'settings', 'messages', 'reports', 'calendar'].some((p) => can(u, p));

// ---- Dates ------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

function toDate(dateStr) {
  return new Date(`${dateStr}T12:00:00`);
}

export function fmtDate(dateStr, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return toDate(dateStr).toLocaleDateString('es', opts);
}

export function fmtLongDate(dateStr) {
  return toDate(dateStr).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function dayLabel(dateStr) {
  const today = todayStr();
  if (dateStr === today) return 'Hoy';
  if (dateStr === addDays(today, 1)) return 'Mañana';
  if (dateStr === addDays(today, -1)) return 'Ayer';
  return fmtDate(dateStr);
}

export function fmtRange(start, end) {
  if (start === end) return dayLabel(start);
  return `${dayLabel(start)} – ${dayLabel(end)}`;
}

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
}

export function scheduleText(a) {
  if (!a.partial) return 'Día completo';
  return a.end_time ? `${fmtTime(a.start_time)} – ${fmtTime(a.end_time)}` : `Desde ${fmtTime(a.start_time)}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return 'ahora';
  if (secs < 3600) return `hace ${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `hace ${Math.floor(secs / 3600)} h`;
  if (secs < 7 * 86400) return `hace ${Math.floor(secs / 86400)} d`;
  return fmtDateTime(iso);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (dateStr) => toDate(dateStr).getDay() || 7;

export const WEEKDAYS = [
  { n: 1, short: 'Lu', name: 'lunes' },
  { n: 2, short: 'Ma', name: 'martes' },
  { n: 3, short: 'Mi', name: 'miércoles' },
  { n: 4, short: 'Ju', name: 'jueves' },
  { n: 5, short: 'Vi', name: 'viernes' },
  { n: 6, short: 'Sá', name: 'sábado' },
  { n: 7, short: 'Do', name: 'domingo' },
];

/** "lunes a viernes", "lunes, miércoles y viernes". */
export function daysText(days = []) {
  const list = WEEKDAYS.filter((d) => days.includes(d.n));
  const consecutive = list.length > 2 && list.every((d, i) => i === 0 || d.n === list[i - 1].n + 1);
  if (consecutive) return `${list[0].name} a ${list[list.length - 1].name}`;
  const names = list.map((d) => d.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0] || '';
}

/** The school's calendar from me(): class hours, school days and grades and groups. */
export function schoolCalendar(school) {
  const c = school?.calendar || {};
  return {
    day_start: c.day_start || '07:40',
    day_end: c.day_end || '15:30',
    school_days: c.school_days?.length ? c.school_days : [1, 2, 3, 4, 5],
    groups: c.groups || [],
  };
}

/** Days without classes ({ start_date, end_date, name, kind }) that touch the range. */
export const closuresIn = (closures, from, to = from) =>
  closures.filter((c) => c.start_date <= to && c.end_date >= from);

export function weekdays(start, end) {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = toDate(d).getDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

// ---- Misc -------------------------------------------------------------------

export function initials(name) {
  const parts = String(name || '')
    .replace(/^(dra?|sra?|srta|lcda?|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function colorIndex(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'file' || el.type === 'submit' || el.type === 'button') continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

/** Disables a button and shows a spinner while fn runs. Errors are shown as toasts. */
export async function busy(button, fn) {
  if (button?.disabled) return;
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.classList.add('is-busy');
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message || 'Ocurrió un error.', 'error');
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.innerHTML = original;
    }
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado', 'ok');
  } catch {
    toast('No se pudo copiar. Selecciona el texto manualmente.', 'error');
  }
}

// ---- Toasts & dialogs -------------------------------------------------------

export function toast(message, type = 'info') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.classList.add('out'), type === 'error' ? 5000 : 3000);
  setTimeout(() => el.remove(), type === 'error' ? 5400 : 3400);
}

/**
 * Promise-based modal dialog. Resolves on confirm with the textarea value (input), the named fields in
 * body (collect) or true; resolves null on cancel. With onSubmit(values, dlg), the dialog stays open while
 * it runs, shows its error inside, and resolves with what it returns.
 */
export function dialog({
  title,
  message = '',
  body = '',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  danger = false,
  input = null,
  collect = false,
  onOpen = null,
  onSubmit = null,
}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = String(html`
      <form method="dialog" class="dialog-inner">
        <h2>${title}</h2>
        ${message ? html`<p class="muted">${message}</p>` : ''}
        ${body}
        ${input
          ? html`<label class="field"><span>${input.label}</span>
              <textarea name="value" rows="3" maxlength="2000" placeholder="${input.placeholder || ''}"></textarea></label>`
          : ''}
        ${onSubmit ? raw('<p class="status-note danger" data-dialog-error hidden></p>') : ''}
        <div class="dialog-actions">
          ${cancelText ? html`<button type="button" class="btn btn-ghost" data-cancel>${cancelText}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${confirmText}</button>
        </div>
      </form>`);
    document.body.append(dlg);
    const done = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => done(null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = dlg.querySelector('form');
      if (!onSubmit) {
        done(input ? dlg.querySelector('textarea').value.trim() : collect ? formValues(form) : true);
        return;
      }
      const button = form.querySelector('[type=submit]');
      const error = form.querySelector('[data-dialog-error]');
      if (button.disabled) return;
      button.disabled = true;
      button.classList.add('is-busy');
      error.hidden = true;
      try {
        done((await onSubmit(formValues(form), dlg)) ?? true);
      } catch (err) {
        error.textContent = err.message || 'Ocurrió un error.';
        error.hidden = false;
        button.disabled = false;
        button.classList.remove('is-busy');
      }
    });
    dlg.showModal();
    onOpen?.(dlg);
  });
}
