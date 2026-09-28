# Leap Attendance Hub

Aplicación web móvil (PWA) para que el personal de una escuela **reporte sus ausencias** y la **dirección y secretaría** las gestionen. Se instala desde el navegador con “Añadir a pantalla de inicio”, sin App Store ni Google Play.

**App:** https://bryanricardoruizortiz63.github.io/LeapAttendanceHub/

Funciona con servicios gratuitos:

| Parte | Dónde vive | Costo |
|---|---|---|
| Pantallas (HTML/CSS/JS) | **GitHub Pages** (carpeta `public/`; el `index.html` de la raíz redirige a ella) | Gratis |
| Base de datos, inicios de sesión y archivos de excusas | **Supabase** (proyecto `leap-attendance-hub`) | Plan gratis |
| Avisos a Teams y notificaciones push | **Supabase Edge Functions** (`supabase/functions/`) | Plan gratis |
| “Mantener activo” y comprobaciones | **GitHub Actions** (`.github/workflows/`) | Gratis |

## Qué hace

**Maestros y personal**
- Entran con **código de escuela + usuario + contraseña**. La primera vez deben cambiar la contraseña temporal.
- Reportan una ausencia en segundos: hoy, mañana o varios días, día completo o parte del día.
- **Causa opcional** (y tipo opcional: enfermedad, cita médica, asunto personal, etc.).
- **Suben su excusa**: foto desde la cámara, PDF o Word (hasta 5 archivos, 10 MB c/u). También pueden añadirla después.
- Dejan instrucciones para quien cubra su clase.
- Ven si la dirección **recibió** su ausencia, quién los cubre y los **comentarios** que les dejaron.

**Dirección y secretaría**
- **Panel**: quién falta hoy, quién no tiene cobertura, qué falta por confirmar y lo que viene en 14 días.
- **Marcar como recibida** (con mensaje opcional al empleado), registrar **cobertura/arreglos** y comentar.
- Registrar una ausencia a nombre de un empleado (por ejemplo, si llamó por teléfono).
- Lista de todas las ausencias con búsqueda y filtros.

**Administración (directora)**
- Acceso con **solo el código de escuela + contraseña de administración** (pestaña “Administración”).
- **Personal**: crear, editar, desactivar y eliminar empleados, restablecer contraseñas y asignar roles.
- **Escuela y Teams**: nombre, webhook de Microsoft Teams y contraseña de administración.
- **Datos y reportes**: estadísticas, exportación a Excel (CSV) y respaldo completo (JSON) de *esa* escuela.

**Notificaciones**
- **Microsoft Teams**: cada ausencia nueva (o cancelada) se publica en el canal que elija la escuela.
- **En la app**: campana con avisos y contador.
- **Push al teléfono**: se activan en *Perfil*. Funcionan en Android, computadoras e iPhone (iOS 16.4+ con la app añadida a la pantalla de inicio).

**Varias escuelas:** cada una tiene su código, su personal, sus ausencias y sus archivos, separados por reglas de seguridad en la base de datos. Desde el **Panel de plataforma** (`#/platform`) se crean escuelas nuevas.

| Rol | Reporta sus ausencias | Ve y confirma las de todos | Personal, Teams y datos |
|---|:-:|:-:|:-:|
| Maestro(a) | ✅ | | |
| Secretaría | ✅ | ✅ | |
| Director(a) | ✅ | ✅ | ✅ |
| Administración (código + contraseña) | | ✅ | ✅ |

---

## Primeros pasos

1. **GitHub Pages (una sola vez):** *Settings → Pages → Build and deployment → Source:* **Deploy from a branch**, rama **`main`**, carpeta **`/ (root)`**. Cada cambio en `main` se publica solo en uno o dos minutos.
2. **Crear tu escuela:** abre la app, toca **Panel de plataforma** (abajo en la pantalla de inicio de sesión), entra con la contraseña de plataforma y crea la escuela. Obtendrás el **código de escuela** y la **contraseña de administración**.
3. **Añadir al personal:** entra en la pestaña **Administración** con el código y esa contraseña → **Personal → Nuevo**. La app muestra los datos de acceso de cada empleado para copiarlos o compartirlos.

### Conectar Microsoft Teams

1. En Teams, ve al canal donde quieres los avisos (por ejemplo, “Dirección”).
2. Toca **⋯** junto al canal → **Workflows** (Flujos de trabajo).
3. Elige **“Publicar en un canal cuando se reciba una solicitud de webhook”** (*Post to a channel when a webhook request is received*).
4. Confirma el equipo y el canal, y copia la URL que aparece al final.
5. En la app: **Más → Escuela y Teams**, pega la URL, **Guardar** y **Enviar prueba**.

### Instalar en los teléfonos

- **iPhone (Safari):** abre la app → **Compartir** → **Añadir a pantalla de inicio**.
- **Android (Chrome):** abre la app → **Instalar app** (o menú ⋮ → *Instalar app*).

Después, en **Perfil → Activar notificaciones**.

---

## Cómo está hecho

```
public/                   La app (sin paso de compilación)
  js/config.js            URL de Supabase, clave pública y clave VAPID pública
  js/backend.js           Todo el acceso a datos (Auth, base de datos, Storage, funciones)
  js/views/               Pantallas
  sw.js                   Service worker (offline + notificaciones push)
  vendor/supabase.js      Cliente oficial de Supabase (supabase-js, MIT)
supabase/
  migrations/             Tablas, reglas de seguridad (RLS) y funciones SQL
  functions/notify/       Envía push y mensajes de Teams (lo llama la base de datos)
  functions/admin/        Acciones de la dirección que requieren permisos de Auth
  functions/platform/     Crear y administrar escuelas
  functions/_shared/      Código común (Web Push con WebCrypto, tarjetas de Teams)
index.html                Redirige de la raíz del sitio a public/ (conservando #/rutas)
.github/workflows/        “Mantener activo” y comprobaciones
```

**Inicio de sesión:** Supabase Auth usa correo, así que cada cuenta recibe un correo interno calculado a partir de *código de escuela + usuario* (por ejemplo `u3f9…@users.leap-hub.local`). Nadie tiene que saberlo ni se envían correos.

**Seguridad:**
- Row Level Security en todas las tablas: cada persona solo ve datos de su escuela; los maestros solo sus propias ausencias.
- Todos los cambios pasan por funciones SQL que validan permisos (`create_absence`, `receive_absence`, …).
- Las excusas se guardan en un bucket privado y se ven con enlaces temporales; cada quien solo sube a su propia carpeta.
- El webhook de Teams solo acepta dominios de Microsoft.
- Las claves privadas (VAPID, contraseña de plataforma) están en la tabla `app_settings`, solo accesible para el servidor.

**Avisos:** al crear una notificación, un *trigger* la pone en la tabla `outbox` y `pg_net` llama a la función `notify`, que envía el push y/o el mensaje de Teams. Cada aviso se procesa una sola vez.

### Plan gratis de Supabase

- Pausa el proyecto tras **una semana sin uso**. El workflow “Mantener Supabase activo” lo visita a diario. Si aun así se pausa (por ejemplo, si GitHub desactiva las tareas programadas de un repositorio sin cambios en 60 días), se reactiva con un botón en el panel de Supabase; los datos no se pierden.
- Límites actuales aproximados: 500 MB de base de datos y 1 GB de archivos, suficiente para varias escuelas.

### Montar un proyecto de Supabase nuevo

1. Aplica los archivos de `supabase/migrations/` en orden.
2. Despliega las funciones de `supabase/functions/` (`notify`, `admin` y `platform`, con *verify JWT* desactivado: cada una valida por su cuenta).
3. Guarda la configuración privada (con tus valores):

```sql
insert into public.app_settings (key, value) values
  ('vapid', jsonb_build_object('publicKey', '<clave pública>', 'privateKey', '<clave privada>', 'subject', '<URL de la app>')),
  ('notify_url', jsonb_build_object('url', 'https://<proyecto>.supabase.co/functions/v1/notify')),
  ('app_url', jsonb_build_object('url', '<URL de la app>')),
  ('platform_password', jsonb_build_object('hash', extensions.crypt('<contraseña de plataforma>', extensions.gen_salt('bf', 10))));
```

4. Pon la URL, la clave pública y la clave VAPID pública en `public/js/config.js` y en `.github/workflows/keepalive.yml`.

Las claves VAPID se pueden generar con `npx web-push generate-vapid-keys`.

## Desarrollo

```bash
npm run dev               # sirve public/ en http://localhost:3000 (usa el proyecto de Supabase real)
npm run check:functions   # revisa los tipos de las Edge Functions (Deno)
npm run test:functions    # pruebas del cifrado push y de las tarjetas de Teams
```
