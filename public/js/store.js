import { api } from './lib.js';
import { unlinkPush } from './pwa.js';

export const state = {
  me: null, // { user, school }
  platform: false,
  config: null,
  unread: 0,
};

export function go(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function homePath() {
  if (state.platform) return '/platform';
  const role = state.me?.user?.role;
  if (!role) return '/login';
  return role === 'teacher' ? '/home' : '/dashboard';
}

export function setUnread(n) {
  state.unread = n;
  for (const el of document.querySelectorAll('[data-unread]')) {
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
  }
  if ('setAppBadge' in navigator) {
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
}

export async function refreshUnread() {
  if (!state.me || state.me.user.must_change_password) return;
  try {
    const { unread } = await api('/notifications/unread-count');
    setUnread(unread);
  } catch {
    /* ignore */
  }
}

export async function logout() {
  await unlinkPush();
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.me = null;
  state.platform = false;
  setUnread(0);
  document.getElementById('toasts')?.replaceChildren();
  go('/login', { replace: true });
}
