import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';

const PLATFORM_PASSWORD = 'platform-pass-123';
let server;
let base;
let teams;
const teamsPosts = [];
let dataDir;

/** Minimal client with its own cookie jar, like a browser tab. */
function client() {
  let cookie = '';
  return async function request(method, url, body, headers = {}) {
    const opts = { method, headers: { Origin: base, ...headers } };
    if (cookie) opts.headers.Cookie = cookie;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opts);
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.startsWith('lah_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lah-test-'));
  teams = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      teamsPosts.push(JSON.parse(body));
      res.writeHead(202).end();
    });
  });
  await new Promise((r) => teams.listen(0, '127.0.0.1', r));

  const app = createApp({ dataDir, platformPassword: PLATFORM_PASSWORD, teamsExtraHosts: ['127.0.0.1'] });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  teams?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe('Leap Attendance Hub API', () => {
  const platform = client();
  const admin = client();
  const teacher = client();
  const secretary = client();
  const otherAdmin = client();
  let school;
  let otherSchool;
  let teacherId;
  let teacherPassword;
  let absenceId;
  let attachmentId;

  it('protects the platform panel with its password', async () => {
    assert.equal((await platform('POST', '/api/auth/platform-login', { password: 'nope' })).status, 401);
    assert.equal((await platform('GET', '/api/platform/schools')).status, 401);
    assert.equal((await platform('POST', '/api/auth/platform-login', { password: PLATFORM_PASSWORD })).status, 200);
  });

  it('creates schools with a code and an admin password', async () => {
    let r = await platform('POST', '/api/platform/schools', { name: 'Leap Academy', code: 'leap-01', admin_password: 'admin-pass-1' });
    assert.equal(r.status, 201);
    school = r.data.school;
    assert.equal(school.code, 'LEAP-01');

    r = await platform('POST', '/api/platform/schools', { name: 'Otra Escuela Modelo', admin_password: 'admin-pass-2' });
    assert.equal(r.status, 201);
    otherSchool = r.data.school;
    assert.match(otherSchool.code, /^[A-Z]+-\d{4}$/);

    r = await platform('POST', '/api/platform/schools', { name: 'Duplicada', code: 'LEAP-01', admin_password: 'admin-pass-3' });
    assert.equal(r.status, 409);
  });

  it('lets the director in with only the school code + admin password', async () => {
    assert.equal((await admin('POST', '/api/auth/admin-login', { school_code: 'LEAP-01', password: 'wrong' })).status, 401);
    const r = await admin('POST', '/api/auth/admin-login', { school_code: 'leap-01', password: 'admin-pass-1' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'admin');
    assert.equal(r.data.school.name, 'Leap Academy');

    const o = await otherAdmin('POST', '/api/auth/admin-login', { school_code: otherSchool.code, password: 'admin-pass-2' });
    assert.equal(o.status, 200);
  });

  it('lets the admin create and edit employees', async () => {
    let r = await admin('POST', '/api/employees', {
      full_name: 'María González',
      email: 'maria@leap.edu',
      position: 'Maestra de 3er grado',
      role: 'teacher',
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.employee.username, 'maria@leap.edu');
    assert.ok(r.data.temp_password.length >= 8);
    teacherId = r.data.employee.id;
    teacherPassword = r.data.temp_password;

    r = await admin('POST', '/api/employees', { full_name: 'Ana López', username: 'ana', role: 'secretary', password: 'secre-pass-1' });
    assert.equal(r.status, 201);

    r = await admin('POST', '/api/employees', { full_name: 'Duplicado', username: 'ANA', role: 'teacher' });
    assert.equal(r.status, 409);

    r = await admin('PATCH', `/api/employees/${teacherId}`, { phone: '787-555-0101' });
    assert.equal(r.status, 200);
    assert.equal(r.data.employee.phone, '787-555-0101');
  });

  it('forces new staff to change their temporary password', async () => {
    let r = await teacher('POST', '/api/auth/login', { school_code: 'LEAP-01', username: 'Maria@leap.edu', password: teacherPassword });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.must_change_password, true);
    assert.equal((await teacher('GET', '/api/absences')).status, 403);

    r = await teacher('POST', '/api/me/password', { current_password: teacherPassword, new_password: 'maria-pass-1' });
    assert.equal(r.status, 200);
    assert.equal((await teacher('GET', '/api/absences')).status, 200);

    r = await secretary('POST', '/api/auth/login', { school_code: 'LEAP-01', username: 'ana', password: 'secre-pass-1' });
    assert.equal(r.status, 200);
    await secretary('POST', '/api/me/password', { current_password: 'secre-pass-1', new_password: 'secre-pass-2' });
  });

  it('rejects a school code that does not match the user', async () => {
    const stranger = client();
    const r = await stranger('POST', '/api/auth/login', { school_code: otherSchool.code, username: 'ana', password: 'secre-pass-2' });
    assert.equal(r.status, 401);
  });

  it('validates the Teams webhook URL and posts a test card', async () => {
    let r = await admin('PATCH', '/api/school', { teams_webhook_url: 'https://example.com/hook' });
    assert.equal(r.status, 400);
    r = await admin('PATCH', '/api/school', {
      teams_webhook_url: 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke',
    });
    assert.equal(r.status, 200);
    r = await admin('PATCH', '/api/school', { teams_webhook_url: `http://127.0.0.1:${teams.address().port}/hook` });
    assert.equal(r.status, 200);
    r = await admin('POST', '/api/school/test-teams');
    assert.equal(r.status, 200);
    assert.equal(teamsPosts.length, 1);
    assert.equal(teamsPosts[0].attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  });

  it('lets a teacher report an absence with an optional reason and a file', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fd = new FormData();
    fd.append('start_date', today);
    fd.append('today', today);
    fd.append('category', 'enfermedad');
    fd.append('reason', 'Fiebre');
    fd.append('coverage_notes', 'Plan en el escritorio');
    fd.append('files', new Blob(['%PDF-1.4 excusa médica'], { type: 'application/pdf' }), 'excusa médica.pdf');
    const r = await teacher('POST', '/api/absences', fd);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    absenceId = r.data.absence.id;
    assert.equal(r.data.absence.status, 'pending');
    assert.equal(r.data.absence.end_date, today);
    assert.equal(r.data.absence.attachment_count, 1);

    assert.ok(await waitFor(() => teamsPosts.length === 2), 'Teams card was posted');
    const card = JSON.stringify(teamsPosts[1]);
    assert.match(card, /María González/);
    assert.match(card, /Fiebre/);
  });

  it('accepts an absence without any reason', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fd = new FormData();
    fd.append('start_date', today);
    fd.append('partial', '1');
    fd.append('start_time', '08:00');
    fd.append('end_time', '10:30');
    fd.append('today', today);
    const r = await teacher('POST', '/api/absences', fd);
    assert.equal(r.status, 201);
    assert.equal(r.data.absence.reason, null);
    assert.equal(r.data.absence.partial, 1);
    // Clean up so later counts stay simple.
    await teacher('POST', `/api/absences/${r.data.absence.id}/cancel`);
  });

  it('rejects disallowed file types and bad dates', async () => {
    const today = new Date().toISOString().slice(0, 10);
    let fd = new FormData();
    fd.append('start_date', today);
    fd.append('files', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'virus.exe');
    let r = await teacher('POST', '/api/absences', fd);
    assert.equal(r.status, 400);

    fd = new FormData();
    fd.append('start_date', '2020-02-30');
    r = await teacher('POST', '/api/absences', fd);
    assert.equal(r.status, 400);
  });

  it('notifies directors/secretaries in the app and shows the absence on the dashboard', async () => {
    let r = await secretary('GET', '/api/notifications');
    assert.equal(r.status, 200);
    assert.ok(r.data.unread >= 1);
    assert.match(r.data.notifications.find((n) => n.link === `#/absence/${absenceId}`).title, /María González/);

    const today = new Date().toISOString().slice(0, 10);
    r = await secretary('GET', `/api/dashboard?today=${today}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.today_list.some((a) => a.id === absenceId));
    assert.equal(r.data.counts.pending, 1);
  });

  it('keeps each school isolated', async () => {
    assert.equal((await otherAdmin('GET', `/api/absences/${absenceId}`)).status, 404);
    const r = await otherAdmin('GET', '/api/absences?scope=school');
    assert.equal(r.data.absences.length, 0);
    assert.equal((await otherAdmin('PATCH', `/api/employees/${teacherId}`, { full_name: 'Hack' })).status, 404);
  });

  it('restricts teachers to their own data', async () => {
    assert.equal((await teacher('GET', '/api/absences?scope=school')).status, 403);
    assert.equal((await teacher('GET', '/api/dashboard')).status, 403);
    assert.equal((await teacher('POST', '/api/employees', { full_name: 'X', username: 'x' })).status, 403);
    assert.equal((await secretary('POST', '/api/employees', { full_name: 'X', username: 'x' })).status, 403);
    assert.equal((await secretary('GET', '/api/data/stats')).status, 403);
  });

  it('serves attachments only to the owner and school staff', async () => {
    let r = await teacher('GET', `/api/absences/${absenceId}`);
    attachmentId = r.data.attachments[0].id;
    assert.equal(r.data.attachments[0].original_name, 'excusa médica.pdf');

    r = await teacher('GET', `/api/attachments/${attachmentId}`);
    assert.equal(r.status, 200);
    assert.match(r.data, /excusa médica/);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);

    assert.equal((await secretary('GET', `/api/attachments/${attachmentId}`)).status, 200);
    assert.equal((await otherAdmin('GET', `/api/attachments/${attachmentId}`)).status, 404);
    assert.equal((await client()('GET', `/api/attachments/${attachmentId}`)).status, 401);
  });

  it('lets staff acknowledge, comment and assign coverage', async () => {
    let r = await admin('POST', `/api/absences/${absenceId}/receive`, { comment: 'Recibido, que te mejores.' });
    assert.equal(r.status, 200);
    assert.equal(r.data.absence.status, 'received');
    assert.equal(r.data.absence.received_by_name, 'Administración');

    r = await secretary('PATCH', `/api/absences/${absenceId}`, { substitute: 'Sra. Díaz' });
    assert.equal(r.data.absence.substitute, 'Sra. Díaz');

    r = await teacher('POST', `/api/absences/${absenceId}/comments`, { body: '¡Gracias!' });
    assert.equal(r.status, 201);

    r = await teacher('GET', `/api/absences/${absenceId}`);
    assert.deepEqual(
      r.data.comments.map((c) => c.body),
      ['Recibido, que te mejores.', '¡Gracias!'],
    );

    r = await teacher('GET', '/api/notifications');
    const titles = r.data.notifications.map((n) => n.title).join(' | ');
    assert.match(titles, /recibida/);
    assert.match(titles, /cobertura/);
  });

  it('exports school data for directors', async () => {
    let r = await admin('GET', '/api/data/export/absences.csv');
    assert.equal(r.status, 200);
    assert.match(r.data, /Empleado/);
    assert.match(r.data, /María González/);
    r = await admin('GET', '/api/data/stats');
    assert.equal(r.status, 200);
    assert.equal(r.data.by_employee[0].full_name, 'María González');
    r = await admin('GET', '/api/data/export/backup.json');
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.data).includes('password_hash'));
  });

  it('lets the teacher cancel and notifies staff', async () => {
    const r = await teacher('POST', `/api/absences/${absenceId}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.data.absence.status, 'cancelled');
    const n = await admin('GET', '/api/notifications');
    assert.ok(n.data.notifications.some((x) => /cancelada/.test(x.title)));
  });

  it('blocks cross-site writes', async () => {
    const r = await admin('POST', '/api/notifications/read-all', {}, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  it('signs out deactivated employees immediately', async () => {
    let r = await admin('PATCH', `/api/employees/${teacherId}`, { active: false });
    assert.equal(r.status, 200);
    assert.equal((await teacher('GET', '/api/me')).data.user, null);
    assert.equal((await teacher('GET', '/api/absences')).status, 401);
    r = await client()('POST', '/api/auth/login', { school_code: 'LEAP-01', username: 'maria@leap.edu', password: 'maria-pass-1' });
    assert.equal(r.status, 401);
  });

  it('refuses to delete employees that have history', async () => {
    const r = await admin('DELETE', `/api/employees/${teacherId}`);
    assert.equal(r.status, 409);
  });
});
