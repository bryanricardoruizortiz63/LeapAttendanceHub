import path from 'node:path';

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    port: Number(env.PORT || 3000),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    platformPassword: env.PLATFORM_ADMIN_PASSWORD || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:soporte@leapattendancehub.app',
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 10),
    trustProxy: env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
    // Extra hosts allowed as Teams webhook targets (used for testing/self-hosted relays).
    teamsExtraHosts: list(env.TEAMS_EXTRA_ALLOWED_HOSTS),
    sessionDays: Number(env.SESSION_DAYS || 30),
    ...overrides,
  };
}
