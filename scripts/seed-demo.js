// Creates a demo school with sample staff and absences so you can try the app.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { createSchool } from '../src/routes/platform.js';
import { addDays, todayLocal } from '../src/util.js';

const config = loadConfig();
const db = openDb(config.dataDir);

if (db.prepare("SELECT 1 FROM schools WHERE code = 'DEMO'").get()) {
  console.log('La escuela DEMO ya existe. Borra la carpeta de datos si quieres empezar de nuevo.');
  process.exit(0);
}

const school = await createSchool(db, { code: 'DEMO', name: 'Escuela Demo Leap', adminPassword: 'admin1234' });
const hash = await hashPassword('demo1234');
const add = db.prepare(
  `INSERT INTO users (school_id, role, username, full_name, email, position, password_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const people = [
  ['director', 'directora', 'Dra. Carmen Rivera', 'directora@demo.edu', 'Directora'],
  ['secretary', 'secretaria', 'Ana López', 'secretaria@demo.edu', 'Secretaria'],
  ['teacher', 'maestra', 'María González', 'maria@demo.edu', 'Maestra de 3er grado'],
  ['teacher', 'jperez', 'José Pérez', 'jose@demo.edu', 'Matemáticas 7mo–8vo'],
  ['teacher', 'lortiz', 'Laura Ortiz', 'laura@demo.edu', 'Inglés'],
  ['teacher', 'rmartinez', 'Roberto Martínez', 'roberto@demo.edu', 'Educación física'],
];
const ids = {};
for (const [role, username, name, email, position] of people) {
  ids[username] = Number(add.run(school.id, role, username, name, email, position, hash).lastInsertRowid);
}

const today = todayLocal();
// Next weekday that is at least `days` away, so demo absences never fall on a weekend.
const weekday = (days) => {
  let d = addDays(today, days);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, days >= 0 ? 1 : -1);
  return d;
};
const absence = db.prepare(
  `INSERT INTO absences (school_id, user_id, created_by, start_date, end_date, partial, start_time, end_time,
                         category, reason, coverage_notes, status, received_by, received_at, substitute)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const now = new Date().toISOString();
absence.run(school.id, ids.maestra, ids.maestra, today, today, 0, null, null, 'enfermedad', 'Fiebre y malestar',
  'Plan de clase en el escritorio. Grupo 3-B: lectura pág. 45.', 'pending', null, null, null);
absence.run(school.id, ids.jperez, ids.jperez, today, today, 1, '08:00', '10:30', 'cita_medica', null,
  'Examen del capítulo 4 en la gaveta.', 'received', ids.directora, now, 'Laura Ortiz (periodo libre)');
absence.run(school.id, ids.rmartinez, ids.rmartinez, weekday(3), weekday(3), 0, null, null, 'oficial',
  'Taller de capacitación del Departamento', null, 'pending', null, null, null);
absence.run(school.id, ids.lortiz, ids.lortiz, weekday(-7), weekday(-7), 0, null, null, 'familiar', null,
  null, 'received', ids.secretaria, now, 'Sustituto: Sr. Cruz');

console.log('\n✅ Escuela de demostración creada');
console.log('   Código de escuela: DEMO');
console.log('   Administración:    contraseña admin1234');
console.log('   Directora:         usuario "directora"  / demo1234');
console.log('   Secretaria:        usuario "secretaria" / demo1234');
console.log('   Maestra:           usuario "maestra"    / demo1234\n');
db.close();
