import { api } from './lib.js';

let deferredInstall = null;
let swRegistration = null;

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    window.dispatchEvent(new CustomEvent('lah:installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        swRegistration = reg;
      })
      .catch((err) => console.warn('No se pudo registrar el service worker', err));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && e.data.url) {
        const hash = new URL(e.data.url, location.origin).hash;
        if (hash) location.hash = hash;
      } else if (e.data?.type === 'push') {
        window.dispatchEvent(new CustomEvent('lah:push'));
      }
    });
  }
}

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const canPromptInstall = () => !!deferredInstall;

export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  return outcome === 'accepted';
}

// ---- Push notifications ----------------------------------------------------

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration() {
  return swRegistration || navigator.serviceWorker.ready;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(b64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

export async function enablePush() {
  if (!pushSupported()) {
    throw new Error(
      isIos() && !isStandalone()
        ? 'En iPhone primero añade la app a tu pantalla de inicio y ábrela desde allí.'
        : 'Este navegador no admite notificaciones.',
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permiso denegado. Actívalo en la configuración del navegador para este sitio.');
  }
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await api('/config');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return sub;
}

export async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** Re-links this device's subscription to the signed-in user (e.g. after switching accounts). */
export async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentPushSubscription();
    if (sub) await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch {
    /* best effort */
  }
}

/** Removes the server-side link so the next person using this phone doesn't get our notifications. */
export async function unlinkPush() {
  try {
    const sub = await currentPushSubscription();
    if (sub) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  } catch {
    /* best effort */
  }
}
