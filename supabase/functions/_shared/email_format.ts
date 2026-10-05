// Text helpers for emails (no network, no npm imports, so they run in tests without permissions).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string | null | undefined): s is string => !!s && s.length <= 200 && EMAIL_RE.test(s);

/** Fills {nombre}, {usuario}… Unknown placeholders are left as they are. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zñáéíóú]+)\}/gi, (match, key: string) => vars[key.toLowerCase()] ?? match);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text → simple HTML: line breaks kept, links clickable. */
export function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#1e4fd8">${url}</a>`)
    .replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fb">
<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;font:15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a2233">${body}</div>
</body></html>`;
}

/** Short Spanish explanation for the most common SMTP problems. */
export function emailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return 'El servidor de correo rechazó el usuario o la contraseña de aplicación.';
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET' || e.code === 'EDNS') {
    return 'No se pudo conectar con el servidor de correo.';
  }
  if (e.responseCode === 550 || e.responseCode === 553) return 'El servidor no aceptó esta dirección de correo.';
  if (e.responseCode === 421 || e.responseCode === 454 || e.responseCode === 452) {
    return 'El servidor de correo pidió esperar (límite de envíos). Inténtalo más tarde.';
  }
  return (e.message || 'Error al enviar el correo.').slice(0, 200);
}

/** Problems that will repeat for every recipient, so there is no point in trying the rest. */
export const isFatalEmailError = (err: unknown) => {
  const e = err as { code?: string; responseCode?: number };
  return ['EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(e.code || '') ||
    [421, 454, 534, 535].includes(e.responseCode || 0);
};
