// "Ícono de la app" (platform panel): builds every icon size from one image, in the browser, and
// applies it to the chosen schools (stored in Supabase). The app-wide default icon still lives in
// GitHub (public/icons) and is used by every school without its own.
import { $, busy, dialog, html, toast } from '../lib.js';
import { iconSet } from '../branding.js';
import { icon } from '../icons.js';

const UPLOAD_URL = 'https://github.com/bryanricardoruizortiz63/LeapAttendanceHub/upload/main/public/icons';

// name → how to draw it. "bg" icons can't be transparent (iPhone, Android adaptive icons).
const OUTPUTS = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  // Android crops adaptive icons to a circle/squircle: keep the artwork inside the central 80%.
  { name: 'icon-maskable-512.png', size: 512, bg: true, scale: 0.8 },
  { name: 'apple-touch-icon.png', size: 180, bg: true },
];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen. Usa un PNG o JPG.'));
    img.src = URL.createObjectURL(file);
  });
}

function draw(img, size, { bg = null, scale = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  // "contain": the whole image fits; a square image fills the icon completely.
  const s = Math.min(size / img.width, size / img.height) * scale;
  const w = img.width * s;
  const h = img.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas;
}

/** Background suggestion: the image's corner color if it is opaque, otherwise white. */
function cornerColor(img) {
  const [r, g, b, a] = draw(img, 64).getContext('2d').getImageData(1, 1, 1, 1).data;
  if (a < 250) return '#ffffff';
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

function save(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const toBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(blob);
  });

/**
 * @param {HTMLElement} slot
 * @param {{ schools: any[], call: (action: string, payload: object) => Promise<any>, onChange: () => void }} opts
 */
export function iconTool(slot, { schools = [], call, onChange } = {}) {
  slot.innerHTML = String(html`
    <section class="card stack">
      <h2 class="card-title">${icon('phone')} Ícono de la app</h2>
      <p class="muted">Elige una imagen cuadrada (PNG o JPG, idealmente de 1024×1024) y las escuelas que la usarán. Su personal
        la verá en la app, en los correos y en las notificaciones.</p>
      <label class="dropzone">
        <input type="file" accept="image/png,image/jpeg,image/webp" data-icon-file>
        ${icon('upload', 26)}
        <strong>Elegir imagen</strong>
        <small>Se procesa en este dispositivo.</small>
      </label>
      <div class="stack" data-icon-result hidden>
        <p class="hint" data-icon-warning hidden></p>
        <div class="icon-previews">
          <figure><img data-preview="icon-512.png" alt=""><figcaption>Navegador</figcaption></figure>
          <figure><img data-preview="apple-touch-icon.png" alt="" class="squircle"><figcaption>iPhone</figcaption></figure>
          <figure><img data-preview="icon-maskable-512.png" alt="" class="circle"><figcaption>Android</figcaption></figure>
        </div>
        <label class="field"><span>Color de fondo (iPhone y Android)</span>
          <input type="color" data-icon-bg></label>
      </div>

      <div class="field"><span>Escuelas</span>
        <div class="people-list">${schools.map((s) => {
          const own = iconSet(s);
          return html`<label class="person">
            <input type="checkbox" value="${s.id}" data-school>
            <img src="${own ? own.i192 : 'icons/icon-192.png'}" alt="" width="32" height="32" class="school-icon">
            <span class="grow"><strong>${s.name}</strong><small>${s.code} · ${own ? 'ícono propio' : 'ícono predeterminado'}</small></span>
          </label>`;
        })}</div>
      </div>
      <div class="button-row">
        <button type="button" class="btn btn-primary" data-icon-apply disabled>${icon('check', 18)} Aplicar a las elegidas</button>
        <button type="button" class="btn btn-ghost" data-icon-reset disabled>Volver al predeterminado</button>
      </div>
      <p class="hint">Dentro de la app cambia al instante. En la pantalla de inicio del teléfono, el ícono nuevo aparece al
        instalar la app; quien ya la tiene debe quitarla y volver a añadirla (iPhone) o reinstalarla (Android).</p>

      <details class="help">
        <summary>Cambiar el ícono predeterminado (el de las escuelas sin ícono propio)</summary>
        <p class="hint">Ese ícono está en el proyecto de GitHub. Con una imagen elegida arriba:</p>
        <button type="button" class="btn btn-secondary btn-block" data-icon-download disabled>${icon('download', 18)} Descargar los 4 archivos</button>
        <ol class="steps">
          <li>Toca <a href="${UPLOAD_URL}" target="_blank" rel="noopener"><b>subir a GitHub</b></a>
            (se abre la carpeta <code>public/icons</code> del proyecto).</li>
          <li>Arrastra los 4 archivos descargados y toca <b>Commit changes</b>.</li>
        </ol>
      </details>
    </section>`);

  const result = $('[data-icon-result]', slot);
  const bgInput = $('[data-icon-bg]', slot);
  const applyBtn = $('[data-icon-apply]', slot);
  const resetBtn = $('[data-icon-reset]', slot);
  let img = null;
  let blobs = {};

  const chosen = () => [...slot.querySelectorAll('[data-school]:checked')].map((c) => c.value);
  function refresh() {
    const ids = chosen();
    applyBtn.disabled = !img || !ids.length;
    resetBtn.disabled = !ids.some((id) => iconSet(schools.find((s) => s.id === id)));
    $('[data-icon-download]', slot).disabled = !img;
  }
  slot.addEventListener('change', (e) => {
    if (e.target.matches('[data-school]')) refresh();
  });

  async function build() {
    blobs = {};
    for (const out of OUTPUTS) {
      const canvas = draw(img, out.size, { bg: out.bg ? bgInput.value : null, scale: out.scale });
      blobs[out.name] = await toBlob(canvas);
      const preview = slot.querySelector(`[data-preview="${out.name}"]`);
      if (preview) {
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(blobs[out.name]);
      }
    }
  }

  $('[data-icon-file]', slot).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      img = await loadImage(file);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const warning = $('[data-icon-warning]', slot);
    const notes = [];
    if (img.width !== img.height) notes.push('La imagen no es cuadrada: se centrará con bordes del color de fondo.');
    if (Math.min(img.width, img.height) < 512) notes.push('La imagen es pequeña (menos de 512 px): puede verse borrosa.');
    warning.textContent = notes.join(' ');
    warning.hidden = !notes.length;
    bgInput.value = cornerColor(img);
    await build();
    result.hidden = false;
    refresh();
  });
  bgInput.addEventListener('input', () => img && build());

  applyBtn.addEventListener('click', () =>
    busy(applyBtn, async () => {
      await build();
      const files = {};
      for (const out of OUTPUTS) files[out.name] = await toBase64(blobs[out.name]);
      const ids = chosen();
      await call('set_school_icon', { school_ids: ids, files });
      toast(`Ícono aplicado a ${ids.length} escuela(s).`, 'ok');
      onChange?.();
    }),
  );

  resetBtn.addEventListener('click', async () => {
    const ids = chosen().filter((id) => iconSet(schools.find((s) => s.id === id)));
    const ok = await dialog({
      title: '¿Volver al ícono predeterminado?',
      message: `${ids.length} escuela(s) dejarán de usar su ícono propio.`,
      confirmText: 'Volver al predeterminado',
    });
    if (!ok) return;
    await busy(resetBtn, async () => {
      await call('reset_school_icon', { school_ids: ids });
      toast('Listo: usan el ícono predeterminado.', 'ok');
      onChange?.();
    });
  });

  $('[data-icon-download]', slot).addEventListener('click', async () => {
    if (!img) return;
    await build();
    for (const out of OUTPUTS) {
      save(out.name, blobs[out.name]);
      // Browsers may block several downloads fired at the same instant.
      await new Promise((r) => setTimeout(r, 400));
    }
    toast('Archivos descargados. Ahora súbelos a GitHub.', 'ok');
  });
}
