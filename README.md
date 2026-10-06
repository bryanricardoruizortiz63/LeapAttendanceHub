# Hallway

Aplicación web móvil (PWA) para que el personal de una escuela **reporte sus ausencias** y la **dirección y secretaría** las gestionen. Se instala desde el navegador con “Añadir a pantalla de inicio”, sin App Store ni Google Play.

**App:** https://bryanricardoruizortiz63.github.io/LeapAttendanceHub/

Antes se llamaba *Leap Attendance Hub*. Solo cambió el nombre visible: la dirección web y los nombres internos (`LeapAttendanceHub`, `users.leap-hub.local`, las claves `lah:` del navegador) se mantienen para no romper las apps instaladas ni los inicios de sesión.

Funciona con servicios gratuitos:

| Parte | Dónde vive | Costo |
|---|---|---|
| Pantallas (HTML/CSS/JS) | **GitHub Pages** (carpeta `public/`; el `index.html` de la raíz redirige a ella) | Gratis |
| Base de datos, inicios de sesión y archivos de excusas | **Supabase** (proyecto `leap-attendance-hub`) | Plan gratis |
| Avisos a Teams y notificaciones push | **Supabase Edge Functions** (`supabase/functions/`) | Plan gratis |
| “Mantener activo” y comprobaciones | **GitHub Actions** (`.github/workflows/`) | Gratis |

## Qué hace

**Maestros y personal**
- Entran con **usuario + contraseña**. El código de escuela viene ya puesto en el enlace que reciben con sus credenciales (`…/?escuela=CÓDIGO`) y el teléfono lo recuerda; solo lo escriben si abren la app sin ese enlace. La primera vez deben cambiar la contraseña temporal.
- **¿Olvidaste tu contraseña?**: avisa a la dirección (en la app, push y Teams). La dirección le da una contraseña temporal desde *Personal*.
- Reportan una ausencia en segundos: hoy, mañana o varios días, día completo o parte del día.
- **Causa opcional** (y tipo opcional: enfermedad, cita médica, asunto personal, etc.).
- **Suben su excusa**: foto desde la cámara, PDF o Word (hasta 5 archivos, 10 MB c/u). También pueden añadirla después.
- Dejan instrucciones para quien cubra su clase (solo en los roles que necesitan cobertura, como Maestro(a); Enfermería, Mantenimiento o Seguridad no ven esos campos).
- Ven si la dirección **recibió** su ausencia, quién los cubre y los **comentarios** que les dejaron.
- **Modifican o cancelan** su propia ausencia mientras no haya pasado. Al cancelar eligen el motivo; si la fecha o la hora estaban mal, la app los lleva a corregirla. Cada cambio queda en el **historial** de la ausencia, y si cambia la fecha u hora de una ausencia ya recibida, la dirección debe confirmarla de nuevo.

**Dirección y secretaría**
- **Panel**: quién falta hoy, quién no tiene cobertura, qué falta por confirmar y lo que viene en 14 días.
- **Marcar como recibida** (con mensaje opcional al empleado), registrar **cobertura/arreglos** y comentar.
- Lista de todas las ausencias con búsqueda y filtros.

**Administración (directora)**
- Acceso con **solo el código de escuela + contraseña de administración** (pestaña “Administración”).
- **Personal**: crear, editar, desactivar y eliminar empleados, restablecer contraseñas y asignar roles. Quien pidió ayuda con su contraseña aparece marcado.
- **Roles y permisos** (solo la cuenta de Administración): añadir, renombrar y borrar roles (vienen Director(a), Secretaría, Maestro(a), Facultad, Enfermería, Mantenimiento y Seguridad) y elegir qué puede hacer cada uno: ver y confirmar las ausencias de todos, administrar el personal, enviar mensajes, datos y reportes, y configurar la escuela. También se elige si sus ausencias **necesitan cobertura** (sustituto). Desde la ficha de un empleado, **+ Nuevo rol…** crea uno sin salir del formulario. Nadie puede dar un rol con más permisos que el suyo, y un rol solo se borra cuando nadie lo tiene.
- **Registrar, modificar o cancelar una ausencia a nombre de un empleado** (por ejemplo, si llamó por teléfono o para corregir un error). Solo la cuenta de Administración puede hacerlo; la directora y la secretaría no.
- **Escuela y Teams**: nombre, código de escuela, webhooks de Microsoft Teams (ausencias y, opcionalmente, otro canal para contraseñas), cuenta de correo, mensaje de bienvenida y contraseña de administración.
- **Cambiar el código de escuela** (solo la cuenta de Administración): por uno más fácil de recordar. No puede repetirse con el de otra escuela (ni con uno que otra escuela usó antes). Todo el personal recibe un aviso en la app y en el teléfono, y un correo si la escuela tiene uno conectado. Usuarios y contraseñas no cambian, y el código anterior y los enlaces viejos siguen funcionando.
- **Enviar el acceso por correo**: al crear un empleado o restablecer su contraseña, un botón le envía su usuario y contraseña temporal al correo de su ficha, con las instrucciones. El texto es editable (*Mensaje con usuario y contraseña*, con `{nombre}`, `{usuario}`, `{contraseña}`, `{enlace}`, `{escuela}`, `{codigo}`) y también es el que se copia o comparte.
- **Correos con diseño**: los correos llevan los colores y el ícono de la app. Las líneas `1.`, `2.` se ven como pasos; una línea que solo tiene un enlace, como botón; las líneas con sangría `Usuario: …`, en un recuadro destacado; y las que empiezan con `•` o `-`, como lista. **Vista previa** muestra el correo tal como llegará.
- **Mensajes**: escribe a todo el personal, a un rol (Maestro(a), Enfermería…) o a personas concretas. Les llega como aviso en la app y notificación en el teléfono, y si quieres también por correo. Se ve a quién le llegó el correo y a quién no.
- **Datos y reportes**: estadísticas, exportación a Excel (.xlsx) y respaldo completo (JSON) de *esa* escuela.
- **Archivo anual**: al terminar el año escolar (1 ago – 31 jul), descarga un Excel con todas sus ausencias (hojas de ausencias, resumen por empleado, historial, comentarios y documentos) y un ZIP con las excusas. Después, la cuenta de Administración puede **liberar espacio**: borra de la app las ausencias recibidas y canceladas de ese año con sus archivos (las que están sin confirmar se quedan).
- Las ausencias **canceladas se borran solas 15 días** después de cancelarse, con sus archivos.

**Notificaciones**
- **Microsoft Teams**: cada ausencia nueva, modificada (con qué cambió) o cancelada (quién y por qué) se publica en el canal que elija la escuela. Las solicitudes de contraseña van al mismo canal o a otro distinto.
- **En la app**: campana con avisos y contador.
- **Push al teléfono**: se activan en *Perfil*. Funcionan en Android, computadoras e iPhone (iOS 16.4+ con la app añadida a la pantalla de inicio).

**Varias escuelas:** cada una tiene su código, su personal, sus ausencias y sus archivos, separados por reglas de seguridad en la base de datos. Desde el **Panel de plataforma** (`#/platform`) se crean escuelas nuevas.

Permisos con los que vienen los roles (la cuenta de Administración los cambia en **Más → Roles y permisos**):

| Rol | Reporta, modifica y cancela | Ve y confirma las de todos | Personal, mensajes, Teams y datos | Necesita cobertura |
|---|:-:|:-:|:-:|:-:|
| Maestro(a), Facultad | Las suyas | | | ✅ |
| Enfermería, Mantenimiento, Seguridad | Las suyas | | | |
| Secretaría | Las suyas | ✅ | | ✅ |
| Director(a) | Las suyas | ✅ | ✅ (sin liberar espacio) | ✅ |
| Administración (código + contraseña) | Las de cualquier empleado | ✅ | ✅ | |

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
5. En la app: **Más → Escuela y Teams**, pega la URL, **Guardar** y **Probar ausencias**.
6. *(Opcional)* Para recibir las solicitudes de contraseña en otro chat o canal, repite los pasos 1–4 allí y pega esa URL en **URL para “Olvidé mi contraseña”** → **Probar contraseñas**. Si lo dejas vacío, llegan al canal de ausencias.

### Conectar el correo (Gmail)

1. Usa una cuenta de Gmail para la escuela (puede ser una nueva solo para esto).
2. Activa la **verificación en 2 pasos** en [myaccount.google.com/security](https://myaccount.google.com/security).
3. En [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) crea una contraseña de aplicación llamada “Hallway”.
4. En la app: **Más → Escuela y Teams → Correo electrónico**, escribe el correo y la contraseña de 16 letras, **Guardar** y **Enviar prueba**.

Gmail permite unos 500 correos al día. También sirve cualquier servidor SMTP en el puerto 465 o 2525 (por ejemplo Brevo). Outlook / Microsoft 365 no sirve: solo usa el puerto 587, que Supabase bloquea.

**Remitente:** el nombre que verá el personal es el de *Nombre que verán* (por ejemplo, “Hallway – Leap Academy”). El circulito junto al remitente en Gmail es la **foto de perfil de esa cuenta de Google**: para que sea el ícono de la app, ponlo como foto en [myaccount.google.com](https://myaccount.google.com) → *Información personal* → *Foto* (puedes descargar el ícono desde `public/icons/icon-512.png`). Dentro del correo, el ícono de la app ya va incluido.

### Cambiar el ícono de la app

1. **Panel de plataforma → Ícono de la app** → elige una imagen cuadrada (idealmente 1024×1024) y ajusta el color de fondo si hace falta.
2. Marca la escuela o las escuelas que lo usarán y toca **Aplicar a las elegidas**.

El personal de esas escuelas lo ve al instante en la app, en los correos y en las notificaciones; las demás escuelas siguen igual. **Volver al predeterminado** quita el ícono propio. En la pantalla de inicio del teléfono, el ícono nuevo aparece al instalar la app: quien ya la tiene debe quitarla y volver a añadirla (iPhone) o reinstalarla (Android).

El ícono **predeterminado** (el de las escuelas sin ícono propio) está en `public/icons`; para cambiarlo, en el mismo panel abre *Cambiar el ícono predeterminado*, descarga los 4 archivos y súbelos a esa carpeta en GitHub.

### Instalar en los teléfonos

- **iPhone (Safari):** abre la app → **Compartir** → **Añadir a pantalla de inicio**.
- **Android (Chrome):** abre la app → **Instalar app** (o menú ⋮ → *Instalar app*).

Después, en **Perfil → Activar notificaciones**.

Conviene abrir primero el enlace recibido con las credenciales: así el código de escuela queda puesto. En iPhone, la app de la pantalla de inicio guarda sus datos aparte de Safari, así que puede pedir el código una vez más; después lo recuerda.

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

**Inicio de sesión:** Supabase Auth usa correo, así que cada cuenta recibe un correo interno calculado a partir de *código de escuela + usuario* (por ejemplo `u3f9…@users.leap-hub.local`). Nadie tiene que saberlo ni se envían correos. Al cambiar el código, la función `admin` recalcula ese correo interno para todas las cuentas de la escuela (todo o nada) y guarda el código anterior en `school_code_history`: si alguien entra con el código viejo, la app pregunta el actual (`current_school_code`) y vuelve a intentar.

**Ícono por escuela:** se guarda en el bucket público `branding/{id de la escuela}/` y `schools.icon_version` indica cuál usar (vacío = el predeterminado). La app lo aplica a los logos, la pestaña del navegador, el ícono de iPhone y el manifiesto de instalación, y lo recuerda en el teléfono.

**Seguridad:**
- Row Level Security en todas las tablas: cada persona solo ve datos de su escuela; los maestros solo sus propias ausencias.
- Todos los cambios pasan por funciones SQL que validan permisos (`create_absence`, `update_absence`, `cancel_absence`, `receive_absence`, …) y quedan en `absence_history`.
- Los roles de cada escuela están en `school_roles` (nombre, permisos y si necesita cobertura); `profiles.role` apunta a uno de ellos. Las reglas de seguridad y las funciones preguntan por permisos (`private.can`, `private.has_perm`), no por nombres de rol.
- Las excusas se guardan en un bucket privado y se ven con enlaces temporales; cada quien solo sube a su propia carpeta.
- El webhook de Teams solo acepta dominios de Microsoft.
- Las claves privadas (VAPID, contraseña de plataforma) están en la tabla `app_settings`, solo accesible para el servidor.
- La contraseña del correo de cada escuela se guarda cifrada en **Supabase Vault**; solo las Edge Functions la leen (`email_account()`, exclusiva de `service_role`). Antes de enviar una contraseña temporal por correo, el servidor comprueba que sigue siendo la vigente.

**Avisos:** al crear una notificación, un *trigger* la pone en la tabla `outbox` y `pg_net` llama a la función `notify`, que envía el push y/o el mensaje de Teams. Cada aviso se procesa una sola vez.

**Mantenimiento diario:** `pg_cron` (7:23 UTC) pone una tarea en `outbox` y `notify` borra las ausencias canceladas hace más de 15 días (con sus archivos), los registros de envío de más de 30 días y los avisos de más de 180 días.

**Correo:** `functions/_shared/email.ts` envía por SMTP con [nodemailer](https://nodemailer.com) (puerto 465), una sola conexión por envío, y deja de intentar si el servidor rechaza la cuenta. `functions/_shared/email_template.ts` convierte el texto en el diseño HTML (tablas y estilos en línea, para que se vea igual en Gmail, Outlook y teléfonos) y el ícono va adjunto dentro del correo, así se ve aunque el lector bloquee las imágenes externas.

**Excel sin librerías:** `js/xlsx.js` y `js/zip.js` generan los .xlsx y el ZIP de documentos en el navegador.

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
