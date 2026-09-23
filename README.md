# Leap Attendance Hub

Aplicación web móvil (PWA) para que el personal de una escuela **reporte sus ausencias** y la **dirección y secretaría** las gestionen. Se instala desde el navegador con “Añadir a pantalla de inicio”, así que no necesita App Store ni Google Play.

## Qué hace

**Maestros y personal**
- Entran con **código de escuela + usuario + contraseña**. La primera vez deben cambiar la contraseña temporal.
- Reportan una ausencia en segundos: hoy, mañana o varios días, día completo o parte del día.
- **Causa opcional** (y tipo opcional: enfermedad, cita médica, asunto personal, etc.).
- **Suben su excusa**: foto desde la cámara, PDF o Word (hasta 5 archivos, 10 MB c/u). También pueden añadirla después.
- Dejan instrucciones para quien cubra su clase.
- Ven si la dirección **recibió** su ausencia, quién los cubre y los **comentarios** que les dejaron.
- Pueden cancelar una ausencia.

**Dirección y secretaría**
- **Panel**: quién falta hoy, quién no tiene cobertura, qué falta por confirmar y lo que viene en los próximos 14 días.
- **Marcar como recibida** (con un mensaje opcional al empleado), registrar **cobertura/arreglos** y conversar por comentarios.
- Registrar una ausencia a nombre de un empleado (por ejemplo, si llamó por teléfono).
- Lista de todas las ausencias con búsqueda y filtros por fecha y estado.

**Administración (directora)**
- Acceso con **solo el código de escuela + contraseña de administración** (pestaña “Administración”).
- **Personal**: crear, editar, desactivar y eliminar empleados, restablecer contraseñas y asignar roles.
- **Escuela y Teams**: nombre, código, webhook de Microsoft Teams y contraseña de administración.
- **Datos y reportes**: estadísticas por empleado y por tipo, exportación a Excel (CSV) y respaldo completo (JSON) con la información de *esa* escuela.

**Notificaciones**
- **Microsoft Teams**: cada ausencia nueva (o cancelada) se publica en el canal que elija la escuela.
- **En la app**: campana con avisos y contador.
- **Push al teléfono**: el personal activa las notificaciones en *Perfil*. Funcionan en Android, en computadoras y en iPhone (iOS 16.4+ con la app añadida a la pantalla de inicio).

**Varias escuelas**
Todo está separado por escuela: cada una tiene su propio código, personal, ausencias, archivos y configuración. Desde el **Panel de plataforma** (`/#/platform`) puedes crear escuelas nuevas cuando abras el servicio a otras.

### Roles

| Rol | Reporta sus ausencias | Ve y confirma las de todos | Personal, Teams y datos |
|---|:-:|:-:|:-:|
| Maestro(a) | ✅ | | |
| Secretaría | ✅ | ✅ | |
| Director(a) | ✅ | ✅ | ✅ |
| Administración (código + contraseña) | | ✅ | ✅ |

---

## Probarlo en tu computadora

Necesitas [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm run seed:demo      # crea la escuela de prueba DEMO
npm start              # abre http://localhost:3000
```

Datos de la escuela de prueba (código **DEMO**):

| Quién | Pestaña | Usuario | Contraseña |
|---|---|---|---|
| Administración | Administración | — | `admin1234` |
| Directora | Personal | `directora` | `demo1234` |
| Secretaria | Personal | `secretaria` | `demo1234` |
| Maestra | Personal | `maestra` | `demo1234` |

## Crear tu escuela

**Opción A, desde la terminal:**

```bash
npm run create-school -- --name "Leap Academy" --code LEAP
# Si no pasas --code se genera uno (ej. LA-4821). Si no pasas --password se genera una segura.
```

**Opción B, desde el Panel de plataforma:** define `PLATFORM_ADMIN_PASSWORD` en el servidor, entra en `https://tu-dominio/#/platform` y crea la escuela.

En ambos casos obtienes el **código de escuela** y la **contraseña de administración**. La directora entra en la pestaña **Administración**, va a **Personal → Nuevo** y crea a cada empleado. La app le muestra al instante los datos de acceso (código, usuario y contraseña temporal) para copiarlos o compartirlos por WhatsApp o correo.

## Conectar Microsoft Teams

1. En Teams, ve al canal donde quieres recibir los avisos (por ejemplo, “Dirección”).
2. Toca **⋯** junto al canal → **Workflows** (Flujos de trabajo).
3. Elige la plantilla **“Publicar en un canal cuando se reciba una solicitud de webhook”** (*Post to a channel when a webhook request is received*).
4. Confirma el equipo y el canal, y copia la URL que aparece al final.
5. En la app: **Más → Escuela y Teams**, pega la URL, toca **Guardar** y luego **Enviar prueba**.

También funcionan las URLs antiguas de “Incoming Webhook” (`*.webhook.office.com`). Puedes decidir si el mensaje incluye la causa de la ausencia (por privacidad, se puede apagar).

## Instalar en los teléfonos

- **iPhone (Safari):** abre la dirección de la app → botón **Compartir** → **Añadir a pantalla de inicio**.
- **Android (Chrome):** abre la dirección → aparece **Instalar app** (o menú ⋮ → *Instalar app / Añadir a pantalla de inicio*).

Después, en **Perfil → Activar notificaciones** para recibir avisos push. La app muestra estas instrucciones a quien aún no la ha instalado.

> Para poder instalarla y usar notificaciones push, la app **tiene que estar publicada con HTTPS**.

---

## Publicarla en internet

La app es un solo servidor Node.js con una base de datos SQLite. Solo necesitas un lugar que ejecute Node o Docker y un **disco persistente** para la carpeta de datos (base de datos + archivos subidos).

### Con Docker (VPS, Railway, Fly.io, Render…)

```bash
docker build -t leap-attendance-hub .
docker run -d -p 3000:3000 \
  -v leap-data:/data \
  -e PUBLIC_URL=https://asistencia.tuescuela.org \
  -e PLATFORM_ADMIN_PASSWORD='una-contraseña-larga' \
  -e VAPID_SUBJECT=mailto:tu-correo@tuescuela.org \
  --name leap leap-attendance-hub

# Crear la primera escuela dentro del contenedor:
docker exec -it leap node scripts/create-school.js --name "Leap Academy" --code LEAP
```

- **Railway / Render / Fly.io:** conecta este repositorio, añade un **volumen persistente** montado en `/data` y define las variables de entorno. Estas plataformas ya dan HTTPS.
- **VPS propio:** usa Docker o `npm ci --omit=dev && npm start` detrás de Nginx/Caddy con HTTPS. Si usas Nginx, reenvía el host (`proxy_set_header Host $host;` y `X-Forwarded-Proto`).

⚠️ Sin disco persistente, los datos se borran cada vez que se reinicia el servidor.

### Variables de entorno

| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | Puerto HTTP | `3000` |
| `DATA_DIR` | Carpeta de la base de datos y archivos | `./data` |
| `PUBLIC_URL` | URL pública, usada en los enlaces de Teams | la del navegador |
| `PLATFORM_ADMIN_PASSWORD` | Activa el Panel de plataforma (`/#/platform`) | vacío = desactivado |
| `VAPID_SUBJECT` | Correo de contacto para notificaciones push | `mailto:soporte@leapattendancehub.app` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves push fijas (opcional) | se generan y guardan solas |
| `MAX_UPLOAD_MB` | Tamaño máximo por archivo | `10` |
| `SESSION_DAYS` | Días que dura una sesión abierta | `30` |
| `TRUST_PROXY` | Proxies de confianza (Express `trust proxy`) | redes privadas |

### Respaldos

Todo vive en `DATA_DIR`: `leap.db` (base de datos) y `uploads/` (excusas). Haz copia de esa carpeta periódicamente. Cada directora también puede descargar el respaldo JSON de su escuela en **Datos y reportes**.

---

## Seguridad

- Contraseñas guardadas con `scrypt`, sesiones en cookies `HttpOnly` + `SameSite` y límite de intentos de inicio de sesión.
- Cada consulta se filtra por escuela: una escuela nunca ve datos de otra.
- Los archivos se sirven solo al empleado dueño y a la dirección/secretaría de su escuela, con encabezados que impiden ejecutar contenido.
- Al desactivar a un empleado o cambiar su rol se cierran sus sesiones de inmediato.
- El webhook de Teams solo acepta dominios de Microsoft (`webhook.office.com`, `logic.azure.com`, `powerplatform.com`).

## Desarrollo

```bash
npm run dev    # reinicia el servidor al guardar cambios
npm test       # pruebas de la API
```

```
server.js            Arranque del servidor
src/
  app.js             Express: seguridad, rutas y archivos estáticos
  db.js              Esquema SQLite y migraciones
  auth.js            Contraseñas, sesiones y permisos
  notifier.js        Avisos en la app, push y Teams
  teams.js / push.js Integraciones
  routes/            API: auth, absences, employees, school, data, notifications, platform
public/              La PWA (HTML/CSS/JS sin paso de compilación)
  js/views/          Pantallas
  sw.js              Service worker (offline + notificaciones push)
scripts/             create-school y seed-demo
test/                Pruebas de integración
```
