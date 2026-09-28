import {
  $,
  CATEGORIES,
  ROLE_LABELS,
  addDays,
  busy,
  dialog,
  fileSize,
  fmtDateTime,
  fmtLongDate,
  formValues,
  html,
  isManager,
  isStaff,
  scheduleText,
  timeAgo,
  toast,
  todayStr,
  weekdays,
} from '../lib.js';
import {
  addAttachments,
  addComment,
  cancelAbsence,
  checkFile,
  createAbsence,
  deleteAttachment,
  getAbsence,
  listEmployees,
  myAbsences,
  receiveAbsence,
  setCoverage,
  updateAbsence,
} from '../backend.js';
import { MAX_FILES, MAX_UPLOAD_MB as maxMb } from '../config.js';
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { absenceList, avatar, empty, installHint, statusBadge } from './common.js';

const ACCEPT = 'image/*,application/pdf,.pdf,.heic,.heif,.doc,.docx';

// ---- Mis ausencias --------------------------------------------------------

export async function homeView({ el }) {
  const absences = await myAbsences(state.me.user.id);
  const today = todayStr();
  const current = absences
    .filter((a) => a.status !== 'cancelled' && a.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = absences.filter((a) => !current.includes(a));
  const firstName = state.me.user.full_name.split(' ')[0];

  el.innerHTML = String(html`
    <section class="hero">
      <div>
        <p class="hero-kicker">Hola, ${firstName} 👋</p>
        <h2>¿Vas a faltar?</h2>
        <p>Avísale a la dirección en segundos. La causa es opcional y puedes adjuntar tu excusa.</p>
      </div>
      <a href="#/report" class="btn btn-light btn-lg btn-block">${icon('plus')} Reportar ausencia</a>
    </section>
    <div data-install-slot></div>
    <section class="section">
      <h3 class="section-title">Hoy y próximas</h3>
      ${current.length
        ? absenceList(current, { showName: false })
        : empty('calendar', 'No tienes ausencias próximas', 'Cuando reportes una, verás aquí si la dirección la recibió.')}
    </section>
    ${past.length
      ? html`<section class="section"><h3 class="section-title">Historial</h3>${absenceList(past, { showName: false })}</section>`
      : ''}`);
  installHint($('[data-install-slot]', el));
}

// ---- Reportar / modificar ---------------------------------------------------

/** Only the employee (while the absence hasn't passed) or the Administración account can edit or cancel it. */
function canChange(a, me) {
  return a.status !== 'cancelled' && (me.role === 'admin' || (a.user_id === me.id && a.end_date >= todayStr()));
}

export const reportView = (ctx) => absenceForm(ctx, null);

export async function editAbsenceView(ctx) {
  const { absence } = await getAbsence(ctx.params[0]);
  if (!canChange(absence, state.me.user)) {
    throw new Error(
      absence.status === 'cancelled'
        ? 'La ausencia está cancelada.'
        : 'Solo el empleado o la cuenta de Administración pueden modificar esta ausencia.',
    );
  }
  return absenceForm(ctx, absence);
}

async function absenceForm({ el, query }, absence) {
  const me = state.me.user;
  const editing = !!absence;
  // Only the school's Administración account registers absences for other people.
  const forOthers = !editing && me.role === 'admin';
  const employees = forOthers ? (await listEmployees()).filter((e) => e.active) : [];
  const today = todayStr();
  const preselect = query.get('user_id') || '';
  const files = [];
  const v0 = absence || { start_date: today, end_date: today, partial: false, category: '', reason: '', coverage_notes: '' };
  const startTime = absence?.start_time?.slice(0, 5) || '08:00';
  const endTime = absence?.end_time?.slice(0, 5) || '';
  const category = v0.category || '';

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      ${forOthers
        ? html`<section class="card">
            <label class="field"><span>¿Quién va a faltar?</span>
              <select name="user_id" required>
                <option value="" ${preselect ? '' : 'selected'} disabled>Selecciona un empleado…</option>
                ${employees.map(
                  (e) => html`<option value="${e.id}" ${String(e.id) === preselect ? 'selected' : ''}>
                    ${e.full_name}${e.position ? ` — ${e.position}` : ''}</option>`,
                )}
              </select>
            </label>
          </section>`
        : ''}
      ${editing && absence.user_id !== me.id
        ? html`<section class="card row">${avatar(absence.employee_name)}<div><strong>${absence.employee_name}</strong>
            <p class="muted">Estás modificando su ausencia.</p></div></section>`
        : ''}

      <section class="card stack">
        <h2 class="card-title">${icon('calendar')} ¿Cuándo?</h2>
        <div class="quick">
          <button type="button" class="chip-btn active" data-quick="0">Hoy</button>
          <button type="button" class="chip-btn" data-quick="1">Mañana</button>
          <button type="button" class="chip-btn" data-quick="range">Varios días</button>
        </div>
        <div class="grid2">
          <label class="field"><span data-start-label>Fecha</span>
            <input type="date" name="start_date" value="${v0.start_date}" min="${addDays(today, -60)}" max="${addDays(today, 365)}" required>
          </label>
          <label class="field" data-end hidden><span>Hasta</span>
            <input type="date" name="end_date" value="${v0.end_date}" min="${v0.start_date}" max="${addDays(today, 365)}">
          </label>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Duración">
          <label class="seg"><input type="radio" name="partial" value="0" ${v0.partial ? '' : 'checked'}> Día completo</label>
          <label class="seg"><input type="radio" name="partial" value="1" ${v0.partial ? 'checked' : ''}> Parte del día</label>
        </div>
        <div class="grid2" data-times hidden>
          <label class="field"><span>Desde</span><input type="time" name="start_time" value="${startTime}"></label>
          <label class="field"><span>Hasta <em class="optional">opcional</em></span><input type="time" name="end_time" value="${endTime}"></label>
        </div>
        <p class="hint" data-summary></p>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('chat')} Motivo <em class="optional">opcional</em></h2>
        <div class="chips" role="radiogroup" aria-label="Tipo de ausencia">
          <label class="chip"><input type="radio" name="category" value="" ${category ? '' : 'checked'}><span>Prefiero no decir</span></label>
          ${Object.entries(CATEGORIES).map(
            ([value, label]) => html`<label class="chip"><input type="radio" name="category" value="${value}" ${category === value ? 'checked' : ''}><span>${label}</span></label>`,
          )}
        </div>
        <label class="field"><span>Causa</span>
          <textarea name="reason" rows="3" maxlength="1000" placeholder="Puedes dejarlo en blanco si prefieres no especificar.">${v0.reason || ''}</textarea>
        </label>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('users')} Para cubrir la clase <em class="optional">opcional</em></h2>
        <label class="field"><span>Instrucciones para quien te cubra</span>
          <textarea name="coverage_notes" rows="3" maxlength="1000"
            placeholder="Ej.: El plan está en el escritorio. Grupo 3-B: lectura pág. 45.">${v0.coverage_notes || ''}</textarea>
        </label>
      </section>

      ${editing
        ? html`<section class="card stack">
            <h2 class="card-title">${icon('edit')} ¿Qué corregiste? <em class="optional">opcional</em></h2>
            <label class="field"><span>Queda en el historial de la ausencia</span>
              <textarea name="note" rows="2" maxlength="500" placeholder="Ej.: Puse el lunes por error, era el martes."></textarea>
            </label>
            <p class="hint">Los documentos se añaden o quitan desde la ausencia.</p>
          </section>`
        : html`<section class="card stack">
            <h2 class="card-title">${icon('clip')} Excusa o evidencia <em class="optional">opcional</em></h2>
            <label class="dropzone">
              <input type="file" name="files" multiple accept="${ACCEPT}">
              ${icon('camera', 26)}
              <strong>Tomar foto o elegir archivo</strong>
              <small>PDF, foto o Word · máx. ${maxMb} MB · hasta ${MAX_FILES} archivos</small>
            </label>
            <ul class="file-list" data-files></ul>
          </section>`}

      <button class="btn btn-primary btn-block btn-lg" type="submit">
        ${editing ? html`${icon('check')} Guardar cambios` : html`${icon('send')} Enviar ausencia`}</button>
      <p class="hint center">${!editing
        ? 'La dirección recibirá una notificación al instante.'
        : absence.status === 'received'
          ? 'La dirección verá el cambio. Si cambias la fecha o la hora, tendrá que confirmarla de nuevo.'
          : 'La dirección verá el cambio y quedará en el historial.'}</p>
    </form>`);

  const form = $('[data-form]', el);
  const start = form.start_date;
  const end = form.end_date;
  const endWrap = $('[data-end]', el);
  const times = $('[data-times]', el);
  const summary = $('[data-summary]', el);
  let multi = v0.start_date !== v0.end_date;

  function update() {
    const partial = form.querySelector('[name=partial]:checked').value === '1';
    if (partial) multi = false;
    endWrap.hidden = !multi;
    times.hidden = !partial;
    $('[data-start-label]', el).textContent = multi ? 'Desde' : 'Fecha';
    end.min = start.value;
    if (!multi || end.value < start.value) end.value = start.value;
    for (const seg of el.querySelectorAll('.segmented .seg')) seg.classList.toggle('active', seg.querySelector('input').checked);
    const quick = multi ? 'range' : start.value === today ? '0' : start.value === addDays(today, 1) ? '1' : '';
    for (const b of el.querySelectorAll('[data-quick]')) b.classList.toggle('active', b.dataset.quick === quick);
    if (start.value) {
      const days = multi ? weekdays(start.value, end.value) : 1;
      summary.textContent = multi && end.value !== start.value
        ? `Del ${fmtLongDate(start.value)} al ${fmtLongDate(end.value)} · ${days} día(s) laborable(s)`
        : `${fmtLongDate(start.value)}${partial ? ' · parte del día' : ''}`;
    }
  }

  for (const b of el.querySelectorAll('[data-quick]')) {
    b.addEventListener('click', () => {
      if (b.dataset.quick === 'range') {
        multi = true;
        form.querySelector('[name=partial][value="0"]').checked = true;
        if (end.value <= start.value) end.value = addDays(start.value, 1);
      } else {
        multi = false;
        start.value = addDays(today, Number(b.dataset.quick));
      }
      update();
    });
  }
  start.addEventListener('change', update);
  end.addEventListener('change', update);
  for (const r of form.querySelectorAll('[name=partial]')) r.addEventListener('change', update);
  update();

  // Files are kept in an array so people can take several photos one by one.
  const fileInput = form.querySelector('[type=file]');
  const list = $('[data-files]', el);
  function renderFiles() {
    list.innerHTML = String(html`${files.map(
      (f, i) => html`<li>${icon('file', 18)}<span>${f.name}</span><small>${fileSize(f.size)}</small>
        <button type="button" class="icon-btn" data-remove="${i}" aria-label="Quitar">${icon('x', 16)}</button></li>`,
    )}`);
    for (const btn of list.querySelectorAll('[data-remove]')) {
      btn.addEventListener('click', () => {
        files.splice(Number(btn.dataset.remove), 1);
        renderFiles();
      });
    }
  }
  fileInput?.addEventListener('change', () => {
    for (const f of fileInput.files) {
      if (files.length >= MAX_FILES) {
        toast(`Máximo ${MAX_FILES} archivos.`, 'error');
        break;
      }
      const problem = checkFile(f);
      if (problem) {
        toast(problem, 'error');
        continue;
      }
      files.push(f);
    }
    fileInput.value = '';
    renderFiles();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      if (forOthers && !v.user_id) throw new Error('Selecciona el empleado que va a faltar.');
      if (!v.start_date) throw new Error('Selecciona la fecha.');
      if (v.partial === '1' && !v.start_time) throw new Error('Indica desde qué hora vas a faltar.');
      if (!multi) v.end_date = null;
      if (editing) {
        await updateAbsence(absence.id, v);
        toast('Cambios guardados', 'ok');
        go(`/absence/${absence.id}`, { replace: true });
        return;
      }
      const id = await createAbsence(state.me, v, files);
      toast('Ausencia enviada. La dirección fue notificada.', 'ok');
      go(`/absence/${id}`, { replace: true });
    });
  });
}

// ---- Detalle ----------------------------------------------------------------

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const HISTORY_LABELS = { edited: 'Modificó la ausencia', cancelled: 'Canceló la ausencia', received: 'La marcó como recibida' };
// Cancelled absences are removed by the daily maintenance job after this many days.
const CANCELLED_KEEP_DAYS = 15;

function historySection(a, history) {
  if (!history.length) return '';
  return html`<section class="card stack">
    <h3 class="card-title">${icon('clock')} Historial</h3>
    <ol class="timeline">
      <li><strong>Reportada</strong> · ${a.created_by_name || a.employee_name}<small>${fmtDateTime(a.created_at)}</small></li>
      ${history.map(
        (h) => html`<li class="t-${h.action}">
          <strong>${HISTORY_LABELS[h.action] || h.action}</strong> · ${h.actor_name}<small>${fmtDateTime(h.created_at)}</small>
          ${h.changes?.length
            ? html`<ul class="changes">${h.changes.map(
                (c) => html`<li><b>${c.label}:</b> <del>${c.before || '—'}</del> <span aria-hidden="true">→</span> <ins>${c.after || '—'}</ins></li>`,
              )}</ul>`
            : ''}
          ${h.note ? html`<p class="pre">${h.action === 'cancelled' ? 'Motivo: ' : ''}${h.note}</p>` : ''}
        </li>`,
      )}
    </ol>
  </section>`;
}

export async function absenceView({ el, params }) {
  const id = params[0];
  const me = state.me.user;
  const staff = isStaff(me);
  let data = await getAbsence(id);
  const employees = staff ? await listEmployees().catch(() => []) : [];

  const render = () => {
    const { absence: a, attachments, comments, history } = data;
    const mine = a.user_id === me.id;
    const cancelled = a.status === 'cancelled';
    const days = a.partial ? null : weekdays(a.start_date, a.end_date);
    const editable = canChange(a, me);
    const cancellation = [...history].reverse().find((h) => h.action === 'cancelled');
    const purgeDay = cancelled
      ? new Date(new Date(a.cancelled_at).getTime() + CANCELLED_KEEP_DAYS * 86_400_000).toLocaleDateString('es', {
          day: 'numeric',
          month: 'long',
        })
      : '';
    const range =
      a.start_date === a.end_date
        ? fmtLongDate(a.start_date)
        : `${fmtLongDate(a.start_date)} → ${fmtLongDate(a.end_date)}`;

    el.innerHTML = String(html`
      <div class="stack">
        <section class="card absence-head">
          <div class="row">
            ${avatar(a.employee_name, 'lg')}
            <div class="grow">
              <h2>${a.employee_name}</h2>
              <p class="muted">${a.employee_position || ROLE_LABELS[a.employee_role]}</p>
            </div>
            ${statusBadge(a.status)}
          </div>
          <div class="when">
            ${icon('calendar')}
            <div>
              <strong class="capitalize">${range}</strong>
              <span>${scheduleText(a)}${days && days > 1 ? ` · ${days} días laborables` : ''}</span>
            </div>
          </div>
          ${a.status === 'received'
            ? html`<p class="status-note ok">${icon('check', 16)} Recibida por ${a.received_by_name || 'la dirección'} · ${fmtDateTime(a.received_at)}</p>`
            : a.status === 'pending'
              ? html`<p class="status-note warn">${icon('clock', 16)} ${staff ? 'Pendiente de confirmar recibo' : 'Enviada · esperando que la dirección la confirme'}</p>`
              : html`<p class="status-note muted">${icon('x', 16)} Cancelada${cancellation ? ` por ${cancellation.actor_name}` : ''} · ${fmtDateTime(a.cancelled_at)}</p>
                ${cancellation?.note ? html`<p class="pre">Motivo: ${cancellation.note}</p>` : ''}
                <p class="hint">Se borrará automáticamente a partir del ${purgeDay}.</p>`}
        </section>

        <section class="card">
          <dl class="details">
            <div><dt>Tipo</dt><dd>${a.category ? CATEGORIES[a.category] : html`<span class="muted">No especificado</span>`}</dd></div>
            <div><dt>Causa</dt><dd class="pre">${a.reason || html`<span class="muted">No especificada</span>`}</dd></div>
            ${a.coverage_notes ? html`<div><dt>Instrucciones para cubrir</dt><dd class="pre">${a.coverage_notes}</dd></div>` : ''}
            <div><dt>Reportada</dt><dd>${fmtDateTime(a.created_at)}${a.created_by && a.created_by !== a.user_id ? ` · registrada por ${a.created_by_name}` : ''}</dd></div>
          </dl>
        </section>

        <section class="card stack">
          <h3 class="card-title">${icon('users')} Cobertura / arreglos</h3>
          ${staff && !cancelled
            ? html`<form class="inline-form" data-coverage>
                <input name="substitute" value="${a.substitute || ''}" maxlength="300" list="emp-names"
                  placeholder="¿Quién cubre? Ej. Sra. Díaz (sustituta)" aria-label="Quién cubre">
                <datalist id="emp-names">${employees.filter((e) => e.id !== a.user_id).map((e) => html`<option value="${e.full_name}">`)}</datalist>
                <button class="btn btn-secondary" type="submit">Guardar</button>
              </form>`
            : html`<p>${a.substitute || html`<span class="muted">Aún no se han registrado arreglos.</span>`}</p>`}
        </section>

        <section class="card stack">
          <h3 class="card-title">${icon('clip')} Documentos ${attachments.length ? html`<span class="count">${attachments.length}</span>` : ''}</h3>
          ${attachments.length
            ? html`<div class="attachments">${attachments.map(
                (f) => html`<div class="att">
                  <a href="${f.url || '#'}" target="_blank" rel="noopener" class="att-link">
                    ${IMAGE_MIME.includes(f.mime) && f.url
                      ? html`<img src="${f.url}" alt="" loading="lazy">`
                      : html`<span class="att-icon">${icon('file', 28)}</span>`}
                    <span class="att-name">${f.original_name}</span>
                    <small>${fileSize(f.size)} · ${f.uploaded_by_name || ''}</small>
                  </a>
                  ${f.uploaded_by === me.id || isManager(me)
                    ? html`<button class="icon-btn att-del" data-del-att="${f.id}" aria-label="Eliminar archivo">${icon('trash', 16)}</button>`
                    : ''}
                </div>`,
              )}</div>`
            : html`<p class="muted">No hay documentos adjuntos.</p>`}
          ${!cancelled && (mine || staff)
            ? html`<label class="btn btn-secondary btn-block file-btn">
                ${icon('upload', 18)} Añadir documento
                <input type="file" multiple accept="${ACCEPT}" data-upload hidden>
              </label>`
            : ''}
        </section>

        <section class="card stack">
          <h3 class="card-title">${icon('chat')} Comentarios ${comments.length ? html`<span class="count">${comments.length}</span>` : ''}</h3>
          ${comments.length
            ? html`<div class="thread">${comments.map(
                (c) => html`<div class="bubble ${c.user_id === me.id ? 'mine' : ''}">
                  <div class="bubble-head"><strong>${c.author_name}</strong><span>${ROLE_LABELS[c.author_role] || ''} · ${timeAgo(c.created_at)}</span></div>
                  <p class="pre">${c.body}</p>
                </div>`,
              )}</div>`
            : html`<p class="muted">${staff ? 'Deja un mensaje al empleado.' : 'Aquí verás los mensajes de la dirección.'}</p>`}
          <form class="comment-form" data-comment>
            <textarea name="body" rows="2" maxlength="2000" required
              placeholder="${staff && !mine ? 'Escribe un comentario para el empleado…' : 'Escribe un mensaje para la dirección…'}"></textarea>
            <button class="btn btn-primary" type="submit" aria-label="Enviar comentario">${icon('send', 18)}</button>
          </form>
        </section>

        ${historySection(a, history)}

        ${editable
          ? html`<div class="button-row split">
              <a class="btn btn-secondary" href="#/absence/${a.id}/edit">${icon('edit', 18)} Modificar</a>
              <button class="btn btn-ghost-danger" data-cancel>${icon('x', 18)} Cancelar ausencia</button>
            </div>`
          : ''}
      </div>
      ${staff && a.status === 'pending'
        ? html`<div class="action-bar"><button class="btn btn-primary btn-block btn-lg" data-receive>${icon('check')} Marcar como recibida</button></div>`
        : ''}`);
    bind();
  };

  const reload = async () => {
    data = await getAbsence(id);
    render();
  };

  function bind() {
    $('[data-receive]', el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const message = await dialog({
        title: 'Confirmar recibo',
        message: `${data.absence.employee_name} verá que su ausencia fue recibida.`,
        input: { label: 'Mensaje para el empleado (opcional)', placeholder: 'Ej.: Recibido, que te mejores. Ya tenemos sustituto.' },
        confirmText: 'Marcar como recibida',
      });
      if (message === null) return;
      await busy(btn, async () => {
        await receiveAbsence(id, message);
        toast('Ausencia marcada como recibida', 'ok');
        await reload();
      });
    });

    const coverage = $('[data-coverage]', el);
    coverage?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(coverage.querySelector('button'), async () => {
        await setCoverage(id, coverage.substitute.value);
        toast('Cobertura guardada', 'ok');
        await reload();
      });
    });

    const comment = $('[data-comment]', el);
    comment.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = comment.body.value.trim();
      if (!body) return;
      busy(comment.querySelector('button'), async () => {
        await addComment(id, body);
        await reload();
        $('.thread .bubble:last-child', el)?.scrollIntoView({ block: 'center' });
      });
    });

    $('[data-upload]', el)?.addEventListener('change', (e) => {
      const input = e.currentTarget;
      const chosen = [...input.files];
      input.value = '';
      const problem = chosen.map(checkFile).find(Boolean);
      if (problem) return toast(problem, 'error');
      if (!chosen.length) return;
      const label = input.closest('label');
      label.classList.add('is-busy');
      addAttachments(state.me, Number(id), chosen.slice(0, MAX_FILES))
        .then(async () => {
          toast('Documento añadido', 'ok');
          await reload();
        })
        .catch((err) => {
          toast(err.message, 'error');
          label.classList.remove('is-busy');
        });
    });

    for (const btn of el.querySelectorAll('[data-del-att]')) {
      btn.addEventListener('click', async () => {
        const ok = await dialog({ title: '¿Eliminar este archivo?', confirmText: 'Eliminar', danger: true });
        if (!ok) return;
        await busy(btn, async () => {
          await deleteAttachment(Number(btn.dataset.delAtt));
          await reload();
        });
      });
    }

    $('[data-cancel]', el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const own = data.absence.user_id === me.id;
      const answer = await dialog({
        title: '¿Por qué la cancelas?',
        message: 'La dirección recibirá un aviso con el motivo (también por Teams).',
        body: html`<div class="choices">
            <label class="choice"><input type="radio" name="reason" value="no_absence" required>
              <span>${own ? 'Ya no voy a faltar' : 'Ya no va a faltar'}</span></label>
            <label class="choice"><input type="radio" name="reason" value="error">
              <span>${own ? 'La registré por error' : 'Se registró por error'}</span></label>
            <label class="choice"><input type="radio" name="reason" value="wrong_date">
              <span>La fecha o la hora están mal<small>No hace falta cancelarla: corrígela y el cambio queda en el historial.</small></span></label>
            <label class="choice"><input type="radio" name="reason" value="other"><span>Otra razón</span></label>
          </div>
          <label class="field" data-note><span>Detalles <em class="optional" data-optional>opcional</em></span>
            <textarea name="note" rows="2" maxlength="450"></textarea></label>`,
        collect: true,
        confirmText: 'Cancelar ausencia',
        cancelText: 'Volver',
        danger: true,
        onOpen(dlg) {
          const note = dlg.querySelector('[name=note]');
          const submit = dlg.querySelector('[type=submit]');
          for (const radio of dlg.querySelectorAll('[name=reason]')) {
            radio.addEventListener('change', () => {
              const fix = radio.value === 'wrong_date';
              note.required = radio.value === 'other';
              dlg.querySelector('[data-optional]').hidden = note.required;
              dlg.querySelector('[data-note]').hidden = fix;
              submit.textContent = fix ? 'Corregir fecha u hora' : 'Cancelar ausencia';
              submit.className = `btn ${fix ? 'btn-primary' : 'btn-danger'}`;
            });
          }
        },
      });
      if (!answer) return;
      if (answer.reason === 'wrong_date') {
        go(`/absence/${id}/edit`);
        return;
      }
      await busy(btn, async () => {
        await cancelAbsence(id, answer.reason, answer.note);
        toast('Ausencia cancelada', 'ok');
        await reload();
      });
    });
  }

  render();
}
