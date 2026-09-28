import { signOut, unreadCount } from './backend.js';
import { unlinkPush } from './pwa.js';

export const state = {
  me: null, // { user, school }
  platformPassword: null,
  unread: 0,
};

export function go(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function homePath() {
  const role = state.me?.user?.role;
  if (!role) return state.platformPassword ? '/platform' : '/login';
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
    setUnread(await unreadCount());
  } catch {
    /* ignore */
  }
}

export async function logout() {
  await unlinkPush();
  // Clear state first so the SIGNED_OUT event isn't treated as an expired session.
  state.me = null;
  state.platformPassword = null;
  await signOut();
  setUnread(0);
  document.getElementById('toasts')?.replaceChildren();
  go('/login', { replace: true });
}
