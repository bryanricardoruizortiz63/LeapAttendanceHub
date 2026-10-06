// Shared by Alertas and Turnos: the student's name and group (only noted students are kept, for 24 hours),
// and screens that keep themselves up to date.
import { similarStudents } from '../backend.js';
import { dialog, html, schoolCalendar } from '../lib.js';
import { state } from '../store.js';

const REFRESH_MS = 15000;

/** Refreshes while the screen is open: every few seconds and whenever a notice arrives. */
export function keepFresh({ onLeave, isCurrent }, load) {
  const tick = () => {
    if (isCurrent() && document.visibilityState === 'visible') load().catch(() => {});
  };
  const timer = setInterval(tick, REFRESH_MS);
  window.addEventListener('lah:push', tick);
  document.addEventListener('visibilitychange', tick);
  onLeave(() => {
    clearInterval(timer);
    window.removeEventListener('lah:push', tick);
    document.removeEventListener('visibilitychange', tick);
  });
}

export function studentFields() {
  const { groups } = schoolCalendar(state.me.school);
  return html`
    <label class="field"><span>Nombre del estudiante</span>
      <input name="student" required maxlength="100" autocomplete="off" autocapitalize="words" placeholder="Nombre y apellidos"></label>
    <label class="field"><span>Grado y grupo</span>
      ${groups.length
        ? html`<select name="group" required>
            <option value="" selected disabled>Elige…</option>
            ${groups.map((g) => html`<option value="${g}">${g}</option>`)}
          </select>`
        : html`<input name="group" required maxlength="20" autocomplete="off" placeholder="Ej. 9-B">`}
    </label>`;
}

/**
 * The student, checking first whether someone already noted a student with a similar name in that group
 * today ("¿Es José Pérez Rivera (9-B)?"). Resolves { id } for one already noted, { name, group } for a new
 * one, or null if the person cancelled.
 */
export async function confirmStudent(name, group) {
  const matches = await similarStudents(name, group);
  const exact = matches.find((m) => m.exact);
  if (exact) return { id: exact.id };
  if (!matches.length) return { name, group };
  const v = await dialog({
    title: '¿Es el mismo estudiante?',
    message: `Hoy ya se apuntó en ${group} a alguien con un nombre parecido.`,
    body: html`<div class="choices" data-same>
      ${matches.map(
        (m, i) => html`<label class="choice"><input type="radio" name="same" value="${m.id}" ${i === 0 ? 'checked' : ''}>
          <span><strong>Sí, es ${m.name} <span class="nowrap">(${m.group_name})</span></strong><small>Se sigue con el mismo estudiante.</small></span></label>`,
      )}
      <label class="choice"><input type="radio" name="same" value="new">
        <span><strong>No, es otro estudiante</strong><small>Se apunta a ${name} (${group}).</small></span></label>
    </div>`,
    confirmText: 'Continuar',
    collect: true,
  });
  if (!v) return null;
  return v.same === 'new' ? { name, group } : { id: Number(v.same) };
}

/** Reads and checks the name and group of a form; the form's own validation shows what's missing. */
export function studentFrom(form) {
  const name = form.student.value.trim().replace(/\s+/g, ' ');
  const group = form.group.value.trim();
  if (name.length < 2) throw new Error('Escribe el nombre del estudiante.');
  if (!group) throw new Error('Elige el grado y grupo del estudiante.');
  return { name, group };
}

/** A label and its value in a detail card (nothing when there's no value). */
export const fact = (label, value) => (value ? html`<div class="fact"><span>${label}</span><strong>${value}</strong></div>` : '');
