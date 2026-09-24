import {
  $,
  CATEGORIES,
  ROLE_LABELS,
  addDays,
  api,
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
import { icon } from '../icons.js';
import { go, state } from '../store.js';
import { absenceList, avatar, empty, installHint, statusBadge } from './common.js';

const MAX_FILES = 5;
const ACCEPT = 'image/*,application/pdf,.pdf,.heic,.heif,.doc,.docx';

// ---- Mis ausencias --------------------------------------------------------

export async function homeView({ el }) {
  const { absences } = await api('/absences?scope=mine');
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

// ---- Reportar -------------------------------------------------------------

export async function reportView({ el, query }) {
  const me = state.me.user;
  const staff = isStaff(me);
  const employees = staff ? (await api('/employees')).employees : [];
  const today = todayStr();
  const preselect = query.get('user_id') || (me.role === 'admin' ? '' : String(me.id));
  const maxMb = state.config?.max_upload_mb || 10;
  const files = [];

  el.innerHTML = String(html`
    <form class="stack" data-form novalidate>
      ${staff
        ? html`<section class="card">
            <label class="field"><span>¿Quién va a faltar?</span>
              <select name="user_id" required>
                <option value="" ${preselect ? '' : 'selected'} disabled>Selecciona un empleado…</option>
                ${employees.map(
                  (e) => html`<option value="${e.id}" ${String(e.id) === preselect ? 'selected' : ''}>
                    ${e.id === me.id ? `Yo (${e.full_name})` : e.full_name}${e.position ? ` — ${e.position}` : ''}</option>`,
                )}
              </select>
            </label>
          </section>`
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
            <input type="date" name="start_date" value="${today}" min="${addDays(today, -60)}" max="${addDays(today, 365)}" required>
          </label>
          <label class="field" data-end hidden><span>Hasta</span>
            <input type="date" name="end_date" value="${today}" min="${today}" max="${addDays(today, 365)}">
          </label>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Duración">
          <label class="seg active"><input type="radio" name="partial" value="0" checked> Día completo</label>
          <label class="seg"><input type="radio" name="partial" value="1"> Parte del día</label>
        </div>
        <div class="grid2" data-times hidden>
          <label class="field"><span>Desde</span><input type="time" name="start_time" value="08:00"></label>
          <label class="field"><span>Hasta <em class="optional">opcional</em></span><input type="time" name="end_time"></label>
        </div>
        <p class="hint" data-summary></p>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('chat')} Motivo <em class="optional">opcional</em></h2>
        <div class="chips" role="radiogroup" aria-label="Tipo de ausencia">
          <label class="chip"><input type="radio" name="category" value="" checked><span>Prefiero no decir</span></label>
          ${Object.entries(CATEGORIES).map(
            ([value, label]) => html`<label class="chip"><input type="radio" name="category" value="${value}"><span>${label}</span></label>`,
          )}
        </div>
        <label class="field"><span>Causa</span>
          <textarea name="reason" rows="3" maxlength="1000" placeholder="Puedes dejarlo en blanco si prefieres no especificar."></textarea>
        </label>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('users')} Para cubrir la clase <em class="optional">opcional</em></h2>
        <label class="field"><span>Instrucciones para quien te cubra</span>
          <textarea name="coverage_notes" rows="3" maxlength="1000"
            placeholder="Ej.: El plan está en el escritorio. Grupo 3-B: lectura pág. 45."></textarea>
        </label>
      </section>

      <section class="card stack">
        <h2 class="card-title">${icon('clip')} Excusa o evidencia <em class="optional">opcional</em></h2>
        <label class="dropzone">
          <input type="file" name="files" multiple accept="${ACCEPT}">
          ${icon('camera', 26)}
          <strong>Tomar foto o elegir archivo</strong>
          <small>PDF, foto o Word · máx. ${maxMb} MB · hasta ${MAX_FILES} archivos</small>
        </label>
        <ul class="file-list" data-files></ul>
      </section>

      <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('send')} Enviar ausencia</button>
      <p class="hint center">La dirección recibirá una notificación al instante.</p>
    </form>`);

  const form = $('[data-form]', el);
  const start = form.start_date;
  const end = form.end_date;
  const endWrap = $('[data-end]', el);
  const times = $('[data-times]', el);
  const summary = $('[data-summary]', el);
  let multi = false;

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
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files) {
      if (files.length >= MAX_FILES) {
        toast(`Máximo ${MAX_FILES} archivos.`, 'error');
        break;
      }
      if (f.size > maxMb * 1024 * 1024) {
        toast(`“${f.name}” pesa más de ${maxMb} MB.`, 'error');
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
      if (staff && !v.user_id) throw new Error('Selecciona el empleado que va a faltar.');
      if (!v.start_date) throw new Error('Selecciona la fecha.');
      if (v.partial === '1' && !v.start_time) throw new Error('Indica desde qué hora vas a faltar.');
      const fd = new FormData();
      for (const [k, val] of Object.entries(v)) {
        if (val === '' || val === null || val === undefined) continue;
        if (v.partial !== '1' && (k === 'start_time' || k === 'end_time')) continue;
        if (!multi && k === 'end_date') continue;
        fd.append(k, val);
      }
      fd.append('today', today);
      for (const f of files) fd.append('files', f, f.name);
      const { absence } = await api('/absences', { method: 'POST', form: fd });
      toast('Ausencia enviada. La dirección fue notificada.', 'ok');
      go(`/absence/${absence.id}`, { replace: true });
    });
  });
}

// ---- Detalle ----------------------------------------------------------------

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function absenceView({ el, params }) {
  const id = params[0];
  const me = state.me.user;
  const staff = isStaff(me);
  let data = await api(`/absences/${id}`);
  const employees = staff ? (await api('/employees').catch(() => ({ employees: [] }))).employees : [];
  const maxMb = state.config?.max_upload_mb || 10;

  const render = () => {
    const { absence: a, attachments, comments } = data;
    const mine = a.user_id === me.id;
    const cancelled = a.status === 'cancelled';
    const days = a.partial ? null : weekdays(a.start_date, a.end_date);
    const canCancel = !cancelled && (staff || (mine && a.end_date >= todayStr()));
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
              : html`<p class="status-note muted">${icon('x', 16)} Cancelada · ${fmtDateTime(a.cancelled_at)}</p>`}
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
                  <a href="/api/attachments/${f.id}" target="_blank" rel="noopener" class="att-link">
                    ${IMAGE_MIME.includes(f.mime)
                      ? html`<img src="/api/attachments/${f.id}" alt="" loading="lazy">`
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

        ${canCancel ? html`<button class="btn btn-ghost-danger btn-block" data-cancel>${icon('x', 18)} Cancelar ausencia</button>` : ''}
      </div>
      ${staff && a.status === 'pending'
        ? html`<div class="action-bar"><button class="btn btn-primary btn-block btn-lg" data-receive>${icon('check')} Marcar como recibida</button></div>`
        : ''}`);
    bind();
  };

  const reload = async () => {
    data = await api(`/absences/${id}`);
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
        await api(`/absences/${id}/receive`, { method: 'POST', body: { comment: message || null } });
        toast('Ausencia marcada como recibida', 'ok');
        await reload();
      });
    });

    const coverage = $('[data-coverage]', el);
    coverage?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(coverage.querySelector('button'), async () => {
        await api(`/absences/${id}`, { method: 'PATCH', body: { substitute: coverage.substitute.value } });
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
        await api(`/absences/${id}/comments`, { method: 'POST', body: { body } });
        await reload();
        $('.thread .bubble:last-child', el)?.scrollIntoView({ block: 'center' });
      });
    });

    $('[data-upload]', el)?.addEventListener('change', (e) => {
      const input = e.currentTarget;
      const chosen = [...input.files];
      input.value = '';
      const tooBig = chosen.find((f) => f.size > maxMb * 1024 * 1024);
      if (tooBig) return toast(`“${tooBig.name}” pesa más de ${maxMb} MB.`, 'error');
      if (!chosen.length) return;
      const fd = new FormData();
      for (const f of chosen.slice(0, MAX_FILES)) fd.append('files', f, f.name);
      const label = input.closest('label');
      label.classList.add('is-busy');
      api(`/absences/${id}/attachments`, { method: 'POST', form: fd })
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
          await api(`/attachments/${btn.dataset.delAtt}`, { method: 'DELETE' });
          await reload();
        });
      });
    }

    $('[data-cancel]', el)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ok = await dialog({
        title: '¿Cancelar esta ausencia?',
        message: 'La dirección será notificada de que ya no vas a faltar.',
        confirmText: 'Sí, cancelar',
        cancelText: 'No',
        danger: true,
      });
      if (!ok) return;
      await busy(btn, async () => {
        await api(`/absences/${id}/cancel`, { method: 'POST' });
        toast('Ausencia cancelada', 'ok');
        await reload();
      });
    });
  }

  render();
}
