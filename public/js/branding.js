// Each school can have its own app icon (set from the platform panel). It is applied to the logos in
// the app, the browser tab, the iPhone "Add to Home Screen" icon and the install manifest, and it is
// remembered on the device so the right icon shows from the first frame.
import { SUPABASE_URL } from './config.js';

const KEY = 'lah:icon';
const DEFAULT = {
  i192: 'icons/icon-192.png',
  i512: 'icons/icon-512.png',
  maskable: 'icons/icon-maskable-512.png',
  apple: 'icons/apple-touch-icon.png',
};

let current = DEFAULT;
let manifestUrl = null;
let manifestCalls = 0;

/** The icon files of a school with its own icon, or null for the default one. */
export function iconSet(school) {
  const id = school?.id || school?.school_id;
  if (!id || !school.icon_version) return null;
  const base = `${SUPABASE_URL}/storage/v1/object/public/branding/${id}/`;
  const v = `?v=${school.icon_version}`;
  return {
    i192: `${base}icon-192.png${v}`,
    i512: `${base}icon-512.png${v}`,
    maskable: `${base}icon-maskable-512.png${v}`,
    apple: `${base}apple-touch-icon.png${v}`,
  };
}

/** The icon to put in <img data-app-icon> when rendering. */
export const appIcon = () => current.i192;

async function useManifest(set) {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return;
  const call = ++manifestCalls;
  let next = null;
  if (set !== DEFAULT) {
    try {
      const base = new URL('manifest.webmanifest', location.href);
      const manifest = await (await fetch(base)).json();
      const abs = (u) => new URL(u, base).href;
      Object.assign(manifest, {
        id: abs(manifest.id),
        start_url: abs(manifest.start_url),
        scope: abs(manifest.scope),
        icons: [
          { src: set.i192, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: set.i512, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: set.maskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: (manifest.shortcuts || []).map((s) => ({ ...s, url: abs(s.url), icons: [{ src: set.i192, sizes: '192x192' }] })),
      });
      next = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    } catch {
      return;
    }
  }
  // Another icon was applied while the manifest loaded: that one wins.
  if (call !== manifestCalls) {
    if (next) URL.revokeObjectURL(next);
    return;
  }
  if (manifestUrl) URL.revokeObjectURL(manifestUrl);
  manifestUrl = next;
  link.href = next || 'manifest.webmanifest';
}

function render(set) {
  current = set;
  document.querySelector('link[rel=icon]')?.setAttribute('href', set.i192);
  document.querySelector('link[rel=apple-touch-icon]')?.setAttribute('href', set.apple);
  for (const img of document.querySelectorAll('img[data-app-icon]')) img.src = set.i192;
  useManifest(set);
}

/** school: { id | school_id, icon_version } or null for the default icon. */
export function applyBranding(school) {
  const set = iconSet(school) || DEFAULT;
  if (set.i192 === current.i192) return;
  try {
    if (set === DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(set));
  } catch {
    /* private mode: the icon just isn't remembered */
  }
  render(set);
}

/** At startup, before anything is drawn. */
export function restoreBranding() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.i192?.startsWith(SUPABASE_URL)) render(saved);
  } catch {
    /* ignore */
  }
}
