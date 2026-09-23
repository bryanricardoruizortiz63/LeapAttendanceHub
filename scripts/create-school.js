// Usage: npm run create-school -- --name "Leap Academy" [--code LEAP] [--password "Secreta123"]
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createSchool } from '../src/routes/platform.js';
import { generatePassword } from '../src/util.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    code: { type: 'string' },
    password: { type: 'string' },
  },
});

if (!values.name) {
  console.error('Uso: npm run create-school -- --name "Nombre de la escuela" [--code CODIGO] [--password CONTRASEÑA]');
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.dataDir);
const password = values.password || generatePassword(12);
try {
  const school = await createSchool(db, { code: values.code, name: values.name, adminPassword: password });
  console.log('\n✅ Escuela creada');
  console.log(`   Nombre:                      ${school.name}`);
  console.log(`   Código de escuela:           ${school.code}`);
  console.log(`   Contraseña de administración: ${password}`);
  console.log('\nEntra en la app → "Administración" con el código y esta contraseña.\n');
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
