import { createApp } from './src/app.js';

const app = createApp();
const { config, db } = app.locals.ctx;

const server = app.listen(config.port, () => {
  console.log(`Leap Attendance Hub escuchando en http://localhost:${config.port}`);
  console.log(`Datos en: ${config.dataDir}`);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM schools').get();
  if (!n) {
    console.log(
      config.platformPassword
        ? 'No hay escuelas todavía. Crea una en /#/platform o con: npm run create-school'
        : 'No hay escuelas todavía. Crea una con: npm run create-school  (o define PLATFORM_ADMIN_PASSWORD para usar /#/platform)',
    );
  }
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
