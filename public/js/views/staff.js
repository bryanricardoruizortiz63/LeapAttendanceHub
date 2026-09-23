import { $, addDays, api, fmtLongDate, html, isManager, todayStr } from '../lib.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { absenceList, empty, installHint } from './common.js';

export async function dashboardView({ el, onLeave, isCurrent }) {
  const me = state.me.user;
  const firstName = me.role === 'admin' ? '' : `, ${me.full_name.replace(/^(dra?|sra?|lcda?)\.?\s+/i, '').split(' ')[0]}`;

  const load = async () => {
    const d = await api(`/dashboard?today=${todayStr()}`);
    if (!isCurrent()) return;
    const c = d.counts;
    el.innerHTML = String(html`
      <div class="hello">
        <p class="muted capitalize">${fmtLongDate(d.today)}</p>
        <h2>Hola${firstName}</h2>
      </div>
      <div class="stats">
        <a class="stat" href="#today"><strong>${c.today}</strong><span>Ausentes hoy</span></a>
        <a class="stat ${c.uncovered_today ? 'stat-danger' : ''}" href="#today"><strong>${c.uncovered_today}</strong><span>Sin cubrir hoy</span></a>
        <a class="stat ${c.pending ? 'stat-warn' : ''}" href="#pending"><strong>${c.pending}</strong><span>Por confirmar</span></a>
        <a class="stat" href="#upcoming"><strong>${c.upcoming}</strong><span>Próximos 14 días</span></a>
      </div>
      <div data-install-slot></div>

      <section class="section" id="today">
        <h3 class="section-title">Ausentes hoy</h3>
        ${d.today_list.length
          ? absenceList(d.today_list)
          : empty('check', '¡Todo el personal está presente hoy!', 'No hay ausencias reportadas para hoy.')}
      </section>

      ${d.pending.length
        ? html`<section class="section" id="pending">
            <h3 class="section-title">Por confirmar <span class="count warn">${d.pending.length}</span></h3>
            ${absenceList(d.pending)}
          </section>`
        : ''}

      <section class="section" id="upcoming">
        <h3 class="section-title">Próximas</h3>
        ${d.upcoming.length ? absenceList(d.upcoming) : html`<p class="muted pad">No hay ausencias en los próximos 14 días.</p>`}
      </section>

      <div class="button-row">
        <a class="btn btn-secondary" href="#/report">${icon('plus', 18)} Registrar ausencia de un empleado</a>
        <a class="btn btn-ghost" href="#/absences">${icon('list', 18)} Ver todas</a>
      </div>`);

    // In-page anchors must not change the route.
    for (const a of el.querySelectorAll('a[href^="#"]:not([href^="#/"])')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' });
      });
    }
    installHint($('[data-install-slot]', el));
  };

  await load();
  const timer = setInterval(() => document.visibilityState === 'visible' && load().catch(() => {}), 60000);
  const onPush = () => load().catch(() => {});
  window.addEventListener('lah:push', onPush);
  onLeave(() => {
    clearInterval(timer);
    window.removeEventListener('lah:push', onPush);
  });
}

export async function absencesListView({ el, query, isCurrent }) {
  const me = state.me.user;
  const today = todayStr();
  const filters = {
    q: query.get('q') || '',
    status: query.get('status') || 'active',
    from: query.has('from') ? query.get('from') : addDays(today, -30),
    to: query.get('to') || '',
    user_id: query.get('user_id') || '',
  };
  const { employees } = await api('/employees?include_inactive=1');
  const selected = employees.find((e) => String(e.id) === filters.user_id);

  el.innerHTML = String(html`
    <form class="card filters" data-filters>
      <label class="search">
        ${icon('search', 18)}
        <input name="q" type="search" placeholder="Buscar empleado…" value="${filters.q}" autocomplete="off">
      </label>
      <div class="grid3">
        <label class="field"><span>Estado</span>
          <select name="status">
            ${[
              ['active', 'Activas'],
              ['pending', 'Por confirmar'],
              ['received', 'Recibidas'],
              ['cancelled', 'Canceladas'],
              ['all', 'Todas'],
            ].map(([v, l]) => html`<option value="${v}" ${filters.status === v ? 'selected' : ''}>${l}</option>`)}
          </select>
        </label>
        <label class="field"><span>Desde</span><input type="date" name="from" value="${filters.from}"></label>
        <label class="field"><span>Hasta</span><input type="date" name="to" value="${filters.to}"></label>
      </div>
      ${selected
        ? html`<div class="filter-chip">${icon('user', 16)} ${selected.full_name}
            <button type="button" class="icon-btn" data-clear-user aria-label="Quitar filtro">${icon('x', 16)}</button></div>`
        : ''}
    </form>
    <div class="list-head">
      <p class="muted" data-count></p>
      ${isManager(me) ? html`<a class="btn btn-ghost btn-sm" data-export href="#">${icon('download', 16)} Exportar CSV</a>` : ''}
    </div>
    <div data-results><div class="loading"><span class="spinner"></span></div></div>`);

  const form = $('[data-filters]', el);
  const results = $('[data-results]', el);
  const count = $('[data-count]', el);
  const exportLink = $('[data-export]', el);
  let seq = 0;

  async function load() {
    const mySeq = ++seq;
    const params = new URLSearchParams({ scope: 'school' });
    for (const [k, v] of Object.entries(filters)) if (v && !(k === 'status' && v === 'all')) params.set(k, v);
    const url = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ''));
    history.replaceState(null, '', `#/absences?${url}`);
    if (exportLink) {
      const exp = new URLSearchParams(Object.entries({ from: filters.from, to: filters.to }).filter(([, v]) => v));
      exportLink.href = `/api/data/export/absences.csv?${exp}`;
    }
    const { absences } = await api(`/absences?${params}`);
    if (mySeq !== seq || !isCurrent()) return;
    count.textContent = `${absences.length} ausencia${absences.length === 1 ? '' : 's'}`;
    results.innerHTML = String(
      absences.length ? absenceList(absences) : empty('search', 'Sin resultados', 'Prueba con otras fechas o filtros.'),
    );
  }

  let debounce;
  form.q.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filters.q = form.q.value.trim();
      load();
    }, 250);
  });
  for (const name of ['status', 'from', 'to']) {
    form[name].addEventListener('change', () => {
      filters[name] = form[name].value;
      load();
    });
  }
  form.addEventListener('submit', (e) => e.preventDefault());
  $('[data-clear-user]', el)?.addEventListener('click', (e) => {
    filters.user_id = '';
    e.currentTarget.closest('.filter-chip').remove();
    load();
  });

  await load();
}
