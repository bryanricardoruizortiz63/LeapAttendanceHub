import { Router } from 'express';
import { requireUser } from '../auth.js';
import { nowIso } from '../db.js';
import { HttpError } from '../util.js';

export default function notificationRoutes({ db, push }) {
  const router = Router();
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL');

  router.get('/notifications', requireUser(), (req, res) => {
    const items = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .all(req.user.id);
    res.json({ notifications: items, unread: unread.get(req.user.id).n });
  });

  router.get('/notifications/unread-count', requireUser(), (req, res) => {
    res.json({ unread: unread.get(req.user.id).n });
  });

  router.post('/notifications/read-all', requireUser(), (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
    res.json({ ok: true });
  });

  router.post('/notifications/:id/read', requireUser(), (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(
      nowIso(),
      Number(req.params.id),
      req.user.id,
    );
    res.json({ ok: true });
  });

  // ---- Web Push ---------------------------------------------------------

  router.post('/push/subscribe', requireUser(), (req, res) => {
    const sub = req.body?.subscription;
    const endpoint = sub?.endpoint;
    const { p256dh, auth } = sub?.keys || {};
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1000 || !p256dh || !auth) {
      throw new HttpError(400, 'Suscripción no válida.');
    }
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(req.user.id, endpoint, String(p256dh).slice(0, 200), String(auth).slice(0, 100));
    res.json({ ok: true });
  });

  router.post('/push/unsubscribe', requireUser(), (req, res) => {
    const endpoint = req.body?.endpoint;
    if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
    res.json({ ok: true });
  });

  router.post('/push/test', requireUser(), async (req, res) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id);
    if (!n) throw new HttpError(400, 'Este dispositivo no tiene las notificaciones activadas.');
    await push.sendToUsers([req.user.id], {
      title: 'Leap Attendance Hub',
      body: '¡Las notificaciones funcionan! 🎉',
      url: '/#/notifications',
    });
    res.json({ ok: true });
  });

  return router;
}
