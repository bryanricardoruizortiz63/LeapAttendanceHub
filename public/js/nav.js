// The bottom bar (side bar on wide screens). "Más" lists whatever doesn't fit here (see moreView).
import { can, isManager, isStaff } from './lib.js';

export const anyManager = (u) => isStaff(u) || isManager(u);

export function navItems(user) {
  const turns = { path: '/turns', icon: 'pulse', label: 'Turnos', match: ['/turns'] };
  // "Mantenimiento" doesn't fit in the bar.
  const maintenance = { path: '/maintenance', icon: 'wrench', label: 'Pedidos', match: ['/maintenance'] };
  const notices = { path: '/notifications', icon: 'bell', label: 'Avisos', badge: true, match: ['/notifications', '/message/'] };
  // Reportar is the big button on Inicio.
  const home = { path: '/home', icon: 'home', label: 'Inicio', match: ['/home', '/absence', '/report', '/rooms'] };
  if (!anyManager(user)) {
    // Mantenimiento has its queue where the others have Turnos; the rest ask for maintenance from Alertas.
    const fixes = can(user, 'maintenance');
    const alerts = { path: '/alerts', icon: 'alert', label: 'Alertas', match: fixes ? ['/alerts'] : ['/alerts', '/maintenance'] };
    return [home, ...(fixes ? [maintenance, alerts] : [alerts, turns]), notices,
      { path: '/profile', icon: 'user', label: 'Perfil', match: ['/profile', '/calendar'] }];
  }
  const alerts = { path: '/alerts', icon: 'alert', label: 'Alertas', match: ['/alerts'] };
  const items = isStaff(user)
    ? [
        { path: '/dashboard', icon: 'grid', label: 'Panel' },
        { path: '/absences', icon: 'list', label: 'Ausencias', match: ['/absences', '/absence/'] },
        alerts,
      ]
    : [{ ...home, match: ['/home', '/absence'] }, alerts, turns];
  const moreMatch = [
    '/more', '/employees', '/settings', '/roles', '/calendar', '/services', '/data', '/messages', '/profile', '/home', '/report',
    '/turns', '/maintenance', '/rooms', '/live',
  ].filter((p) => !items.some((i) => i.path === p));
  items.push(notices, { path: '/more', icon: 'menu', label: 'Más', match: moreMatch });
  return items;
}

/** Whether this path is already a tab, so "Más" doesn't repeat it. */
export const inTabBar = (user, path) => navItems(user).some((i) => i.path === path);
