import webpush from 'web-push';

/**
 * Web Push (works on Android, desktop, and iOS 16.4+ when the app is added to the home screen).
 * VAPID keys come from env vars or are generated once and stored in the database.
 */
export function createPush({ db, config }) {
  let publicKey = config.vapidPublicKey;
  let privateKey = config.vapidPrivateKey;

  if (!publicKey || !privateKey) {
    const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
    const stored = getSetting.get('vapid');
    if (stored) {
      ({ publicKey, privateKey } = JSON.parse(stored.value));
    } else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(
        'vapid',
        JSON.stringify({ publicKey, privateKey }),
      );
    }
  }
  webpush.setVapidDetails(config.vapidSubject, publicKey, privateKey);

  const subsFor = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?');
  const removeSub = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

  async function sendToUsers(userIds, payload) {
    const body = JSON.stringify(payload);
    const jobs = [];
    for (const userId of new Set(userIds)) {
      for (const sub of subsFor.all(userId)) {
        const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        jobs.push(
          webpush.sendNotification(subscription, body, { TTL: 60 * 60 * 24, urgency: 'high' }).catch((err) => {
            if (err.statusCode === 404 || err.statusCode === 410) removeSub.run(sub.id);
            else console.warn('[push] envío fallido:', err.statusCode || err.message);
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  return { publicKey, sendToUsers };
}
