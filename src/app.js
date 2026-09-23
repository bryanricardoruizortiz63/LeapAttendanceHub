import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sessionMiddleware } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createNotifier } from './notifier.js';
import { createPush } from './push.js';
import { uploadErrorMessage } from './uploads.js';
import { HttpError } from './util.js';
import absenceRoutes from './routes/absences.js';
import authRoutes, { meRoutes } from './routes/auth.js';
import dataRoutes from './routes/data.js';
import employeeRoutes from './routes/employees.js';
import notificationRoutes from './routes/notifications.js';
import platformRoutes from './routes/platform.js';
import schoolRoutes from './routes/school.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

/** Blocks cross-site state-changing requests (defense in depth on top of SameSite cookies). */
function sameOriginWrites(config) {
  const publicHost = config.publicUrl ? new URL(config.publicUrl).host : null;
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    // Reverse proxies may rewrite Host, so also accept the forwarded host and PUBLIC_URL.
    const allowed = [req.get('host'), req.get('x-forwarded-host'), publicHost].filter(Boolean);
    if (!host || !allowed.includes(host)) throw new HttpError(403, 'Origen no permitido.');
    next();
  };
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dataDir);
  const push = createPush({ db, config });
  const notifier = createNotifier({ db, config, push });
  const ctx = { db, config, push, notifier };

  // Clean up expired sessions now and then.
  const purge = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  purge();
  setInterval(purge, 6 * 60 * 60 * 1000).unref();

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.locals.ctx = ctx;

  app.use(securityHeaders);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(sessionMiddleware(db, config));
  api.use(sameOriginWrites(config));
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.get('/config', (req, res) =>
    res.json({
      public_key: push.publicKey,
      max_upload_mb: config.maxUploadMb,
      platform_enabled: !!config.platformPassword,
    }),
  );
  api.use('/auth', authRoutes(ctx));
  api.use('/me', meRoutes(ctx));
  api.use('/employees', employeeRoutes(ctx));
  api.use('/school', schoolRoutes(ctx));
  api.use('/data', dataRoutes(ctx));
  api.use('/platform', platformRoutes(ctx));
  api.use(absenceRoutes(ctx));
  api.use(notificationRoutes(ctx));
  api.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use('/api', api);

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res) {
        // Always revalidate so a new deploy reaches phones quickly (ETags keep it cheap).
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const uploadMsg = uploadErrorMessage(err, config);
    if (uploadMsg) return res.status(400).json({ error: uploadMsg });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande.' });
    console.error(err);
    res.status(500).json({ error: 'Ocurrió un error inesperado. Inténtalo de nuevo.' });
  });

  return app;
}
