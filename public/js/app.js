import { getMe } from './backend.js';
import { can, html, isManager, isStaff, raw, toast } from './lib.js';
import { icon } from './icons.js';
import { initPwa, syncPush } from './pwa.js';
import { go, homePath, refreshUnread, setUnread, state } from './store.js';
import { adoptSchoolFromUrl, changePasswordView, loginView, rememberSchool } from './views/auth.js';
import { appIcon, applyBranding, restoreBranding } from './branding.js';
import { absenceView, editAbsenceView, homeView, reportView } from './views/absences.js';
import { absencesListView, dashboardView } from './views/staff.js';
import { dataView, employeeFormView, employeesView, settingsView } from './views/admin.js';
import { rolesView } from './views/roles.js';
import { moreView, notificationsView, profileView } from './views/account.js';
import { platformView } from './views/platform.js';
import { composeView, messageView, messagesView } from './views/messages.js';

// Who may open each screen: by the permissions of the person's role.
const PEOPLE = (u) => u.role !== 'admin';
const STAFF = (u) => isStaff(u);
const ADMIN = (u) => u.role === 'admin';
const ANY_MANAGER = (u) => isStaff(u) || isManager(u);
const may = (perm) => (u) => can(u, perm);

const ROUTES = [
  { re: /^\/login$/, view: loginView, public: true, bare: true },
  { re: /^\/platform$/, view: platformView, public: true, bare: true },
  { re: /^\/change-password$/, view: changePasswordView, bare: true },
  { re: /^\/home$/, view: homeView, title: 'Mis ausencias', allow: PEOPLE },
  { re: /^\/report$/, view: reportView, title: 'Reportar ausencia', back: true },
  { re: /^\/absence\/(\d+)$/, view: absenceView, title: 'Ausencia', back: true },
  { re: /^\/absence\/(\d+)\/edit$/, view: editAbsenceView, title: 'Modificar ausencia', back: true },
  { re: /^\/dashboard$/, view: dashboardView, title: 'Panel', allow: STAFF },
  { re: /^\/absences$/, view: absencesListView, title: 'Ausencias', allow: STAFF },
  { re: /^\/employees$/, view: employeesView, title: 'Personal', allow: may('staff') },
  // Employee ids are Supabase Auth UUIDs.
  { re: /^\/employees\/(new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, view: employeeFormView, title: 'Empleado', allow: may('staff'), back: true },
  { re: /^\/settings$/, view: settingsView, title: 'Escuela y Teams', allow: may('settings'), back: true },
  { re: /^\/roles$/, view: rolesView, title: 'Roles y permisos', allow: ADMIN, back: true },
  { re: /^\/data$/, view: dataView, title: 'Datos y reportes', allow: may('reports'), back: true },
  { re: /^\/messages$/, view: messagesView, title: 'Mensajes', allow: may('messages') },
  { re: /^\/messages\/new$/, view: composeView, title: 'Nuevo mensaje', allow: may('messages'), back: true },
  { re: /^\/message\/(\d+)$/, view: messageView, title: 'Mensaje', back: true },
  { re: /^\/notifications$/, view: notificationsView, title: 'Avisos' },
  { re: /^\/profile$/, view: profileView, title: 'Mi perfil' },
  { re: /^\/more$/, view: moreView, title: 'Más', allow: ANY_MANAGER },
];

function navItems(user) {
  const report = { path: '/report', icon: 'plus', label: 'Reportar' };
  const notices = { path: '/notifications', icon: 'bell', label: 'Avisos', badge: true, match: ['/notifications', '/message/'] };
  if (!ANY_MANAGER(user)) {
    return [
      { path: '/home', icon: 'home', label: 'Inicio', match: ['/home', '/absence'] },
      report,
      notices,
      { path: '/profile', icon: 'user', label: 'Perfil' },
    ];
  }
  const items = isStaff(user)
    ? [
        { path: '/dashboard', icon: 'grid', label: 'Panel' },
        { path: '/absences', icon: 'list', label: 'Ausencias', match: ['/absences', '/absence/'] },
        can(user, 'staff') ? { path: '/employees', icon: 'users', label: 'Personal' } : report,
      ]
    : [{ path: '/home', icon: 'home', label: 'Inicio', match: ['/home', '/absence'] }, report];
  const moreMatch = ['/more', '/settings', '/roles', '/data', '/messages', '/profile', '/home', '/report'].filter(
    (p) => !items.some((i) => i.path === p),
  );
  items.push(notices, { path: '/more', icon: 'menu', label: 'Más', match: moreMatch });
  return items;
}

const appRoot = document.getElementById('app');
let shellKey = null;
let navSeq = 0;
let cleanups = [];

function renderShell(route, path) {
  const { user, school } = state.me;
  const key = `${user.id}:${user.role}:${(user.permissions || []).join()}`;
  if (shellKey !== key || !document.getElementById('view')) {
    shellKey = key;
    appRoot.innerHTML = String(html`
      <div class="shell">
        <nav class="tabbar" aria-label="Navegación principal">
          <div class="side-brand">
            <img src="${appIcon()}" alt="" width="36" height="36" data-app-icon>
            <div><strong>Leap Attendance Hub</strong><small>${school.name}</small></div>
          </div>
          ${navItems(user).map(
            (item) => html`<a class="tab" href="#${item.path}" data-path="${item.path}"
                data-match="${(item.match || [item.path]).join(',')}">
                <span class="tab-icon">${icon(item.icon, 22)}${item.badge ? raw('<b class="dot" data-unread hidden></b>') : ''}</span>
                <span>${item.label}</span></a>`,
          )}
        </nav>
        <div class="main-col">
          <header class="topbar">
            <button class="icon-btn" data-back aria-label="Volver">${icon('back', 22)}</button>
            <img class="topbar-logo" src="${appIcon()}" alt="" width="30" height="30" data-app-icon>
            <div class="topbar-title"><h1 id="page-title"></h1><small>${school.name}</small></div>
            <a class="icon-btn" href="#/notifications" aria-label="Avisos">${icon('bell', 22)}<b class="dot" data-unread hidden></b></a>
          </header>
          <main id="view" class="view"></main>
        </div>
      </div>`);
    appRoot.querySelector('[data-back]').addEventListener('click', () => {
      if (history.length > 1) history.back();
      else go(homePath());
    });
    setUnread(state.unread);
  }
  document.body.classList.remove('bare');
  document.getElementById('page-title').textContent = route.title || '';
  document.title = `${route.title ? `${route.title} · ` : ''}Leap Attendance Hub`;
  appRoot.querySelector('.topbar').classList.toggle('has-back', !!route.back);
  for (const tab of appRoot.querySelectorAll('.tab')) {
    const active = tab.dataset.match.split(',').some((m) => path === m || path.startsWith(m.endsWith('/') ? m : `${m}/`));
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

async function router() {
  const [rawPath, queryString = ''] = location.hash.replace(/^#/, '').split('?');
  const path = rawPath || '/';
  const query = new URLSearchParams(queryString);

  for (const fn of cleanups) fn();
  cleanups = [];

  let match = null;
  const route = ROUTES.find((r) => (match = path.match(r.re)));
  const user = state.me?.user;

  if (!route) return go(homePath(), { replace: true });
  if (!route.public && !user) {
    // Remember where they were going (e.g. a link from Teams) to continue there after signing in.
    state.nextPath = `${path}${queryString ? `?${queryString}` : ''}`;
    return go('/login', { replace: true });
  }
  if (user?.must_change_password && path !== '/change-password') return go('/change-password', { replace: true });
  if (path === '/login' && user) return go(homePath(), { replace: true });
  if (route.allow && !route.allow(user)) return go(homePath(), { replace: true });

  const seq = ++navSeq;
  const el = document.createElement('div');
  el.className = 'view-inner';
  el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

  if (route.bare) {
    shellKey = null;
    document.body.classList.add('bare');
    document.title = 'Leap Attendance Hub';
    appRoot.replaceChildren(el);
  } else {
    renderShell(route, path);
    document.getElementById('view').replaceChildren(el);
  }
  window.scrollTo(0, 0);

  const ctx = {
    el,
    params: match.slice(1),
    query,
    state,
    isCurrent: () => seq === navSeq,
    onLeave: (fn) => cleanups.push(fn),
    setTitle: (t) => {
      const h = document.getElementById('page-title');
      if (h) h.textContent = t;
    },
    reload: () => router(),
  };

  try {
    await route.view(ctx);
  } catch (err) {
    if (seq !== navSeq) return;
    el.innerHTML = String(html`
      <div class="empty">
        ${icon('alert', 40)}
        <h3>No se pudo cargar</h3>
        <p>${err.message}</p>
        <button class="btn btn-secondary" data-retry>${icon('refresh')} Reintentar</button>
      </div>`);
    el.querySelector('[data-retry]').addEventListener('click', () => router());
  }
  if (user && !route.bare) refreshUnread();
}

function sessionEnded() {
  if (!state.me) return;
  state.me = null;
  toast('Tu sesión expiró. Vuelve a entrar.', 'error');
  go('/login', { replace: true });
}

async function boot() {
  initPwa();
  restoreBranding();
  adoptSchoolFromUrl();
  try {
    state.me = await getMe();
  } catch (err) {
    toast(err.message, 'error');
  }
  if (state.me) {
    // The school may have changed its code or icon since this device last saw it.
    rememberSchool(state.me.school);
    applyBranding(state.me.school);
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('lah:unauthorized', sessionEnded);
  window.addEventListener('lah:signed-out', sessionEnded);
  window.addEventListener('lah:push', refreshUnread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUnread();
  });
  setInterval(refreshUnread, 60000);

  if (state.me) syncPush();
  if (!location.hash || location.hash === '#' || location.hash === '#/') go(homePath(), { replace: true });
  else router();
}

boot();
