// Loaded before the app (a plain script, not a module). If the app doesn't start, for example right after an update
// when the phone mixes a file of the old version with the new ones, it shows a way out instead of a blank screen:
// «Actualizar» downloads the app's files again from the server and reopens it.
(() => {
  let started = false;
  // app.js calls it as soon as all its modules loaded.
  window.hallwayStarted = () => {
    started = true;
    document.getElementById('boot-rescue')?.remove();
  };

  async function refresh(button) {
    button.disabled = true;
    button.textContent = 'Actualizando…';
    // Everything this page asked for (scripts, styles, icons) and the page itself, straight from the server: it
    // replaces the old copies the phone keeps.
    const own = (url) => url.startsWith(location.origin);
    const urls = [
      location.href.split('#')[0],
      ...window.performance.getEntriesByType('resource').map((e) => e.name).filter(own),
    ];
    await Promise.all([
      ...[...new Set(urls)].map((url) => fetch(url, { cache: 'reload' }).catch(() => null)),
      'caches' in window ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => null) : null,
      navigator.serviceWorker
        ? navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.update().catch(() => null)))).catch(() => null)
        : null,
    ]);
    location.reload();
  }

  function rescue() {
    const app = document.getElementById('app');
    if (started || !app || document.getElementById('boot-rescue')) return;
    app.innerHTML = `<main class="view"><section class="card" id="boot-rescue">
      <div class="empty">
        <h3>No se pudo abrir Hallway</h3>
        <p>Puede pasar justo después de una actualización. Toca «Actualizar» para descargar la versión nueva.</p>
        <button type="button" class="btn btn-primary btn-block">Actualizar</button>
      </div>
    </section></main>`;
    const button = app.querySelector('#boot-rescue button');
    button.addEventListener('click', () => refresh(button));
  }

  // A module that doesn't load (or doesn't fit with the others) shows up as an error before the app starts…
  window.addEventListener('error', () => {
    if (!started) setTimeout(rescue, 300);
  });
  // …or the app simply never starts.
  window.addEventListener('load', () => setTimeout(rescue, 2500));
})();
