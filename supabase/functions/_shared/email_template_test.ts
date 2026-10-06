import { assert, assertEquals } from 'jsr:@std/assert@1';
import { brandedHtml, renderBody } from './email_template.ts';

const WELCOME = `Hola María:

1. Abre este enlace desde tu teléfono:
https://example.org/app/?escuela=LEAP

2. Entra con estos datos:
   Usuario: maria
   Contraseña temporal: Kp7mWq2xTz

3. Añádela a la pantalla de inicio:
   • iPhone (Safari): Compartir → Añadir.
   • Android (Chrome): menú ⋮ → Instalar app.

Si tienes dudas, comunícate con la dirección.`;

Deno.test('numbered lines become steps, a lone link becomes a button', () => {
  const html = renderBody(WELCOME, ['maria', 'Kp7mWq2xTz']);
  assertEquals((html.match(/border-radius:14px;background:#e7eeff/g) || []).length, 3);
  assert(html.includes('href="https://example.org/app/?escuela=LEAP"'));
  assert(html.includes('Abrir Hallway &rarr;'));
});

Deno.test('indented "Label: value" lines become the credentials box', () => {
  const html = renderBody(WELCOME, ['maria', 'Kp7mWq2xTz']);
  assert(html.includes('border-left:4px solid #1e4fd8'));
  assert(html.includes('>Usuario</div>'));
  assert(/font:700 18px\/1\.3 [^"]*">Kp7mWq2xTz<\/span>/.test(html));
  assert(html.includes('<li style="margin:2px 0">iPhone (Safari): Compartir → Añadir.</li>'));
});

Deno.test('text is escaped and highlights only match whole words', () => {
  const html = renderBody('Hola <b>ana</b>, la semana del 5 & 6. Tu usuario: ana.', ['ana']);
  assert(html.includes('&lt;b&gt;'));
  assert(!html.includes('<b>'));
  assert(html.includes('&amp; 6'));
  assert(html.includes('sem' + 'ana del')); // "semana" untouched
  // "Tu usuario: ana." is highlighted; "<b>ana</b>" is not (no word boundary before it).
  assertEquals((html.match(/>ana<\/span>/g) || []).length, 1);
});

Deno.test('brandedHtml has the app header, logo, title, intro and button', () => {
  const html = brandedHtml({
    title: 'Reunión <viernes>',
    intro: 'De Dra. Rivera · Leap Academy',
    text: 'Nos vemos a las 3.',
    schoolName: 'Leap Academy',
    logoSrc: 'cid:leap-logo',
    preheader: 'Nos vemos a las 3.',
    cta: { url: 'https://example.org/app/#/message/1', label: 'Ver en Hallway' },
  });
  assert(html.includes('src="cid:leap-logo"'));
  assert(html.includes('linear-gradient(135deg,#1e4fd8,#1a43b8)'));
  assert(html.includes('Reunión &lt;viernes&gt;'));
  assert(html.includes('De Dra. Rivera · Leap Academy'));
  assert(html.includes('href="https://example.org/app/#/message/1"'));
  assert(html.includes('Enviado por <b style="color:#0f172a">Leap Academy</b>'));
});
