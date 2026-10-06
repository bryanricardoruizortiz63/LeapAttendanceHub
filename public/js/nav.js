// The bottom bar (side bar on wide screens). "Más" lists whatever doesn't fit here (see moreView).
import { isManager, isStaff } from './lib.js';

export const anyManager = (u) => isStaff(u) || isManager(u);

export function navItems(user) {
  const report = { path: '/report', icon: 'plus', label: 'Reportar' };
  const alerts = { path: '/alerts', icon: 'alert', label: 'Alertas', match: ['/alerts'] };
  const notices = { path: '/notifications', icon: 'bell', label: 'Avisos', badge: true, match: ['/notifications', '/message/'] };
  const home = { path: '/home', icon: 'home', label: 'Inicio', match: ['/home', '/absence'] };
  if (!anyManager(user)) {
    return [home, alerts, report, notices, { path: '/profile', icon: 'user', label: 'Perfil', match: ['/profile', '/calendar'] }];
  }
  const items = isStaff(user)
    ? [
        { path: '/dashboard', icon: 'grid', label: 'Panel' },
        { path: '/absences', icon: 'list', label: 'Ausencias', match: ['/absences', '/absence/'] },
        alerts,
      ]
    : [home, alerts, report];
  const moreMatch = ['/more', '/employees', '/settings', '/roles', '/calendar', '/data', '/messages', '/profile', '/home', '/report'].filter(
    (p) => !items.some((i) => i.path === p),
  );
  items.push(notices, { path: '/more', icon: 'menu', label: 'Más', match: moreMatch });
  return items;
}

/** Whether this path is already a tab, so "Más" doesn't repeat it. */
export const inTabBar = (user, path) => navItems(user).some((i) => i.path === path);
