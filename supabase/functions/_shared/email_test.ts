import { assert, assertEquals } from 'jsr:@std/assert@1';
import { emailError, isEmail, renderTemplate, textToHtml } from './email_format.ts';

Deno.test('renderTemplate fills known placeholders and keeps unknown ones', () => {
  const out = renderTemplate('Hola {nombre}: usuario {usuario}, clave {contraseña} ({Escuela}) {otro}', {
    nombre: 'María',
    usuario: 'maria',
    'contraseña': 'Abc12345',
    escuela: 'Leap',
  });
  assertEquals(out, 'Hola María: usuario maria, clave Abc12345 (Leap) {otro}');
});

Deno.test('textToHtml escapes markup, keeps line breaks and links', () => {
  const html = textToHtml('Hola <b>Ana</b>\nEntra: https://example.org/app/?escuela=X&y=1');
  assert(html.includes('Hola &lt;b&gt;Ana&lt;/b&gt;<br>'));
  assert(html.includes('<a href="https://example.org/app/?escuela=X&amp;y=1"'));
  assert(!html.includes('<b>Ana'));
});

Deno.test('isEmail', () => {
  assert(isEmail('maria@escuela.edu'));
  assert(!isEmail('maria@escuela'));
  assert(!isEmail('maria escuela@x.com'));
  assert(!isEmail(null));
});

Deno.test('emailError explains common SMTP failures in Spanish', () => {
  assertEquals(emailError({ code: 'EAUTH', responseCode: 535 }), 'El servidor de correo rechazó el usuario o la contraseña de aplicación.');
  assertEquals(emailError({ code: 'ETIMEDOUT' }), 'No se pudo conectar con el servidor de correo.');
  assertEquals(emailError({ responseCode: 550 }), 'El servidor no aceptó esta dirección de correo.');
});
