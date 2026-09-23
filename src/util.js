export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const ROLES = ['admin', 'director', 'secretary', 'teacher'];
export const STAFF_ROLES = ['admin', 'director', 'secretary'];
export const MANAGER_ROLES = ['admin', 'director'];

export const ROLE_LABELS = {
  admin: 'Administración',
  director: 'Director(a)',
  secretary: 'Secretaría',
  teacher: 'Maestro(a)',
};

export const CATEGORIES = {
  enfermedad: 'Enfermedad',
  cita_medica: 'Cita médica',
  personal: 'Asunto personal',
  familiar: 'Emergencia familiar',
  oficial: 'Capacitación / oficial',
  otro: 'Otro',
};

export const STATUS_LABELS = {
  pending: 'Enviada',
  received: 'Recibida',
  cancelled: 'Cancelada',
};

export function isStaff(user) {
  return !!user && STAFF_ROLES.includes(user.role);
}

export function isManager(user) {
  return !!user && MANAGER_ROLES.includes(user.role);
}

/** Trimmed string or null; throws if longer than max. */
export function optText(value, max, label) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `${label} es demasiado largo (máx. ${max} caracteres).`);
  return s;
}

export function reqText(value, max, label) {
  const s = optText(value, max, label);
  if (!s) throw new HttpError(400, `${label} es requerido.`);
  return s;
}

export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

export function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Accepts a client-provided "today" (device-local date) and falls back to server date. */
export function clientToday(value) {
  return isDate(value) ? value : todayLocal();
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

/** Weekdays (Mon–Fri) between two dates, inclusive. */
export function weekdaysBetween(start, end) {
  let count = 0;
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

export function formatDateEs(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function formatRangeEs(start, end) {
  return start === end ? formatDateEs(start) : `${formatDateEs(start)} al ${formatDateEs(end)}`;
}

export function toCsv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralize spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function generatePassword(length = 10) {
  // No ambiguous characters (0/O, 1/l/I) so it is easy to dictate or type on a phone.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  }
  if (pw.length > 200) throw new HttpError(400, 'La contraseña es demasiado larga.');
}

export function normalizeSchoolCode(code) {
  return String(code || '').trim().toUpperCase();
}

export function validateSchoolCode(code) {
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code)) {
    throw new HttpError(400, 'El código de escuela debe tener de 3 a 20 letras, números o guiones.');
  }
}
