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
- Al elegir la fecha, la app avisa si ese día no hay clases (feriado o día sin estudiantes del calendario escolar).
- En *Perfil* ponen su **salón** (y lo cambian cuando quieran) y ven sus **grupos** (9-B, 10-A…), que asigna la dirección. También ven el **calendario escolar**: horario y días sin clases.
- **Modifican o cancelan** su propia ausencia mientras no haya pasado. Al cancelar eligen el motivo; si la fecha o la hora estaban mal, la app los lleva a corregirla. Cada cambio queda en el **historial** de la ausencia, y si cambia la fecha u hora de una ausencia ya recibida, la dirección debe confirmarla de nuevo.

**Alertas** (pestaña *Alertas*, para todo el personal)
- **No ha llegado**: si un estudiante debía llegar al salón y no llegó, el maestro escribe su nombre y grupo, de dónde venía (Baño, Enfermería, Oficina… o lo que escriba) y elige a quién avisar: **Seguridad** (Seguridad, la dirección y la secretaría) o **todo el personal**. Les llega al instante con alarma. Quien lo encuentre toca **«Apareció / está conmigo»** (y si quiere, dónde estaba); el maestro puede tocar **«Ya llegó al salón»**. A todos les llega que apareció, y queda cuánto tardó.
- **Salidas** (lo vienen a buscar): el maestro anota al estudiante, la hora aproximada y una nota («Lo recoge su abuela»), y Seguridad recibe el aviso. Cuando llega el encargado, lo marca el maestro (se avisa a Seguridad) o Seguridad (se avisa al maestro). Seguridad toca **«Voy al salón»** y luego **«Entregado»**, con quién lo recogió si quiere. Todos ven cada paso en *Salidas de hoy*.
- **Relevo**: el maestro toca **«Pedir relevo»** (el salón sale de su perfil). Les llega a los maestros, la dirección y la secretaría; el primero que toca **«Yo lo relevo»** va, al maestro se le avisa quién, y a los demás que ya no hace falta.
- **Estudiantes**: no hay lista de estudiantes. Solo se guarda el que un maestro apunta para una alerta, una salida o un turno, **24 horas**, para que otro maestro pueda seguirlo. Si se escribe un nombre parecido a uno apuntado ese día en el mismo grupo, la app pregunta «¿Es José Pérez Rivera (9-B)?». Pasadas las 24 horas se borran el nombre y los avisos que lo mencionaban; la alerta queda sin nombre.
- **Avisos urgentes**: suenan y vibran con la app abierta (pantalla de alarma) y, con la app cerrada, la notificación vibra largo y se queda en pantalla (Android). Si nadie la abre, se repite cada minuto por 15 minutos o hasta que alguien se encargue. Una app web no puede sonar con el teléfono en silencio; para eso será la app de las tiendas, al final.

**Turnos** (pestaña *Turnos*: Enfermería, Trabajo Social y otros servicios)
- **Pedir turno**: el maestro elige el servicio (ve si hay alguien disponible y cuántos hay en fila), el estudiante, **qué tan grave es** (Baja, Media, Alta o Urgente), el **motivo** (de una lista del servicio) y una nota. El motivo y la nota solo los ven ese maestro y el servicio; los otros maestros del grupo ven cómo va el turno, no por qué.
- **La fila** del servicio va por gravedad y, dentro de cada nivel, por orden de llegada; cada 30 minutos de espera un turno sube un nivel (hasta Alta) para que nadie se quede olvidado. Urgente llega con alarma. El profesional puede escoger otro turno y queda anotado.
- **Enfermería** (el estudiante va a la oficina): la enfermera toca **«Llamar»** y al maestro le llega «Envía a Juan (9-B)» con alarma; el maestro toca **«Ya salió»**. Si no llega en 5 minutos (se cambia por servicio), se avisa a la enfermera, al maestro y a **Seguridad**, que recibe una alerta «No ha llegado». La enfermera marca **«Llegó»** y luego **«Regresa al salón»** (el maestro toca **«Llegó al salón»**), **«Lo recogieron»** o **«Referido»**. Si llega un estudiante sin turno, la enfermera lo anota con **«Llegó sin turno»**.
- **Trabajo Social** (la profesional va al salón): **«Voy en camino»** le avisa al maestro, y luego **«Atendido»** o **«Referido»**.
- **Si el estudiante cambia de salón**, el maestro que lo tiene ahora (de ese grupo) toca **«Está conmigo»** y desde ahí los avisos le llegan a él.
- **Estado del profesional**: Disponible, En reunión, Almuerzo o Fuera hasta una hora. Los maestros lo ven al pedir un turno.
- **Historial**: el servicio conserva sus turnos con nombre (hasta un año) y solo él los ve, con las visitas anteriores de cada estudiante. Los maestros ven los turnos de sus grupos solo 24 horas.
- **Servicios** (*Más → Servicios*, quien configura la escuela): nombre, si el estudiante va o el profesional va al salón, minutos para llegar, qué roles lo atienden y la lista de motivos. Vienen Enfermería (rol Enfermería) y Trabajo Social (rol nuevo Trabajo Social).

**Mantenimiento** (*Alertas → Mantenimiento*; el personal de Mantenimiento tiene su pestaña *Pedidos*)
- **Pedir**: el maestro elige qué hace falta (derrame, limpieza, baño, basura, reparación u otro), dónde (su salón, ya puesto; se puede cambiar), la urgencia (**Cuando puedan**, **Pronto** o **Urgente**) y, si quiere, una nota o una **foto**. Si ya hay una solicitud abierta de lo mismo en el mismo lugar, la app lo dice en vez de repetirla.
- **Mantenimiento** la recibe al instante; *Pronto* y *Urgente* llegan con alarma y se repiten hasta que alguien la abre.
- **La fila** va por urgencia y, dentro de cada una, por orden de llegada. **«Voy en camino»** le avisa al maestro (y al resto de Mantenimiento que ya va alguien); **«Listo»**, con lo que se hizo si quiere, le avisa que está resuelto, y la app sugiere la siguiente. Si quien iba no puede, toca **«Ya no puedo ir»** y vuelve a la fila.
- El maestro sigue sus solicitudes en *Alertas* y puede cancelarlas; Mantenimiento también, con el motivo. La dirección y la secretaría ven todas en *Más → Mantenimiento*.
- Las fotos solo las ven quien pidió y quien puede ver la solicitud, y se borran 30 días después de cerrarse.

**Salón de conferencias** (*Inicio → Salón de conferencias*; en la dirección, *Más*)
- **Reservar por horas**: para qué es, el día y de qué hora a qué hora, dentro del horario escolar. Los días marcados en el calendario escolar (*Feriado* o *Sin estudiantes*) no se pueden reservar, y la app recuerda revisarlo. Todo el personal ve para qué es, así que no se escriben datos privados.
- **Semana y mes**: cada día muestra las reservas aprobadas, las que esperan aprobación y las **horas libres**, con un botón para reservar en ellas. En el mes, cada día dice cuántas reservas tiene y los días sin clases salen en gris.
- **Aprobación**: la secretaría y la dirección (permiso *Calendario escolar*) aprueban o no, con el motivo si quieren. Les llega un aviso con cada pedido y en el *Panel* ven cuántos esperan. Al aprobar una, las demás pedidas para esa hora se rechazan solas. A quien no se le aprueba le llega el aviso con las horas libres de ese día.
- **Prioridad**: las reservas de la secretaría y la dirección se aprueban solas. Si eligen una hora que ya tiene un maestro, la app pregunta «¿Reemplazar la reserva?»; si dicen que sí, la del maestro se cancela y le llega el aviso con las horas libres. Una reserva de la secretaría o la dirección no la reemplaza nadie.
- Quien reservó puede cancelarla; la secretaría y la dirección también, con el motivo. Dos reservas aprobadas nunca chocan.

**Paneles** (cada uno con su Excel; período: este mes, mes pasado, año escolar, año escolar pasado o las fechas que elijas)
- **En vivo** (*Panel* o *Más → En vivo*; permiso *Datos y reportes*: la dirección y Administración): lo que pasa ahora en la escuela. De Enfermería y Trabajo Social, quién atiende y su estado, y quién está en fila, en camino o en atención y desde cuándo (sin el motivo ni la nota); también las alertas «No ha llegado», las salidas de hoy, los relevos pedidos, el mantenimiento abierto y el salón de conferencias de hoy. Se actualiza solo.
- **Panel de cada servicio** (*Turnos → Panel y Excel*; solo quien atiende el servicio): turnos, estudiantes, espera y atención promedio, resultados, quién no llegó a tiempo y quién llegó sin turno; por motivo, día, hora, grupo y gravedad, y los estudiantes con más turnos. El Excel trae cada turno, las visitas por estudiante y por motivo, pero nunca las notas.
- **Cerrar el año** del servicio: al terminar el año escolar, se elige el período, se descarga el Excel y se borran de la app los turnos terminados de ese período, para que el historial con nombres no pase al año siguiente.
- **Panel de mantenimiento** (*Mantenimiento → Panel y Excel*; Mantenimiento, la dirección y la secretaría): solicitudes, resueltas, tiempo hasta «en camino» y hasta «listo»; por tipo, lugar, urgencia, día y quién las resolvió.
- **Uso del salón** (*Salón de conferencias → Uso del salón y Excel*; la secretaría y la dirección): reservas aprobadas, horas, qué parte del horario de clases se usó, horas por persona y por día, y el estado de las reservas.

**Dirección y secretaría**
- **Panel**: quién falta hoy, quién no tiene cobertura, qué falta por confirmar y lo que viene en 14 días.
- **Marcar como recibida** (con mensaje opcional al empleado), registrar **cobertura/arreglos** y comentar.
- Lista de todas las ausencias con búsqueda y filtros.

**Administración (directora)**
- Acceso con **solo el código de escuela + contraseña de administración** (pestaña “Administración”).
- **Personal**: crear, editar, desactivar y eliminar empleados, restablecer contraseñas y asignar roles, salón y grupos. Quien pidió ayuda con su contraseña aparece marcado. Se puede buscar por nombre, puesto, salón o grupo.
- **Calendario escolar** (Secretaría, Director(a) y Administración; permiso *Calendario escolar*): horario de clases (7:40 a. m. a 3:30 p. m., lunes a viernes, se puede cambiar), **días sin clases** (*Feriado*: no se trabaja; *Sin estudiantes*: el personal trabaja, por ejemplo desarrollo profesional) y los **grados y grupos** de la escuela (uno a uno o varios a la vez: «del 7 al 12, grupos A, B, C»). Al cambiar el nombre de un grupo, quienes lo tienen lo conservan; al borrarlo, se les quita. Es la base de los demás módulos (turnos, alertas y reservas). Este permiso también aprueba las **reservas del salón de conferencias**.
- **Roles y permisos** (solo la cuenta de Administración): añadir, renombrar y borrar roles (vienen Director(a), Secretaría, Maestro(a), Facultad, Enfermería, Trabajo Social, Mantenimiento y Seguridad) y elegir qué puede hacer cada uno: ver y confirmar las ausencias de todos, administrar el personal, el calendario escolar, enviar mensajes, datos y reportes, configurar la escuela, Seguridad (alertas y salidas) y Mantenimiento (atender las solicitudes). También se elige si sus ausencias **necesitan cobertura** (sustituto). Desde la ficha de un empleado, **+ Nuevo rol…** crea uno sin salir del formulario. Nadie puede dar un rol con más permisos que el suyo (salvo Mantenimiento, que es una tarea y no da acceso a datos de otros: quien administra el personal lo puede dar), y un rol solo se borra cuando nadie lo tiene.
- **Registrar, modificar o cancelar una ausencia a nombre de un empleado** (por ejemplo, si llamó por teléfono o para corregir un error). Solo la cuenta de Administración puede hacerlo; la directora y la secretaría no.
- **Escuela y Teams**: nombre, código de escuela, webhooks de Microsoft Teams (ausencias y, opcionalmente, otro canal para contraseñas), cuenta de correo, mensaje de bienvenida y contraseña de administración.
- **Cambiar el código de escuela** (solo la cuenta de Administración): por uno más fácil de recordar. No puede repetirse con el de otra escuela (ni con uno que otra escuela usó antes). Todo el personal recibe un aviso en la app y en el teléfono, y un correo si la escuela tiene uno conectado. Usuarios y contraseñas no cambian, y el código anterior y los enlaces viejos siguen funcionando.
- **Enviar el acceso por correo**: al crear un empleado o restablecer su contraseña, un botón le envía su usuario y contraseña temporal al correo de su ficha, con las instrucciones. El texto es editable (*Mensaje con usuario y contraseña*, con `{nombre}`, `{usuario}`, `{contraseña}`, `{enlace}`, `{escuela}`, `{codigo}`) y también es el que se copia o comparte.
- **Correos con diseño**: los correos llevan los colores y el ícono de la app. Las líneas `1.`, `2.` se ven como pasos; una línea que solo tiene un enlace, como botón; las líneas con sangría `Usuario: …`, en un recuadro destacado; y las que empiezan con `•` o `-`, como lista. **Vista previa** muestra el correo tal como llegará.
- **Mensajes**: escribe a todo el personal, a un rol (Maestro(a), Enfermería…) o a personas concretas. Les llega como aviso en la app y notificación en el teléfono, y si quieres también por correo. Se ve a quién le llegó el correo y a quién no.
- **Datos y reportes**: estadísticas, exportación a Excel (.xlsx) y respaldo completo (JSON) de *esa* escuela, y los enlaces a los demás paneles.
- **Archivo anual**: al terminar el año escolar (1 ago – 31 jul), descarga un Excel con todas sus ausencias (hojas de ausencias, resumen por empleado, historial, comentarios y documentos) y un ZIP con las excusas. Después, la cuenta de Administración puede **liberar espacio**: borra de la app las ausencias recibidas y canceladas de ese año con sus archivos (las que están sin confirmar se quedan).
- Las ausencias **canceladas se borran solas 15 días** después de cancelarse, con sus archivos.

**Notificaciones**
- **Microsoft Teams**: cada ausencia nueva, modificada (con qué cambió) o cancelada (quién y por qué) se publica en el canal que elija la escuela. Las solicitudes de contraseña van al mismo canal o a otro distinto.
- **En la app**: campana con avisos y contador.
- **Push al teléfono**: se activan en *Perfil*. Funcionan en Android, computadoras e iPhone (iOS 16.4+ con la app añadida a la pantalla de inicio).

**Varias escuelas:** cada una tiene su código, su personal, sus ausencias y sus archivos, separados por reglas de seguridad en la base de datos. Desde el **Panel de plataforma** (`#/platform`) se crean escuelas nuevas.

Permisos con los que vienen los roles (la cuenta de Administración los cambia en **Más → Roles y permisos**):

| Rol | Reporta, modifica y cancela | Ve y confirma las de todos | Calendario escolar | Personal, mensajes, Teams y datos | Necesita cobertura |
|---|:-:|:-:|:-:|:-:|:-:|
| Maestro(a), Facultad | Las suyas | | Lo ve | | ✅ |
| Enfermería, Trabajo Social, Mantenimiento, Seguridad | Las suyas | | Lo ve | | |
| Secretaría | Las suyas | ✅ | ✅ | | ✅ |
| Director(a) | Las suyas | ✅ | ✅ | ✅ (sin liberar espacio) | ✅ |
| Administración (código + contraseña) | Las de cualquier empleado | ✅ | ✅ | ✅ | |

El permiso **Seguridad** (recibe las alertas «No ha llegado» enviadas a Seguridad y se encarga de las salidas) viene en Seguridad, Secretaría, Director(a) y Administración. El permiso **Mantenimiento** (recibe y atiende las solicitudes de mantenimiento) viene en Mantenimiento y Administración. El permiso **Datos y reportes** también abre el tablero **En vivo**. La barra de abajo tiene **Alertas** para todos y **Turnos** (Mantenimiento tiene **Pedidos** en su lugar); en la dirección, *Turnos*, *Mantenimiento*, *Salón de conferencias*, *Personal* y *Reportar* están en *Más*, y para los demás *Reportar* es el botón grande de *Inicio*, donde también está el *Salón de conferencias*.

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

**Calendario, grupos y salón:** el horario y los grados y grupos están en `school_settings` (`day_start`, `day_end`, `school_days`, `groups`) y llegan a la app con `me()`; los días sin clases, en `school_closures`. Cada persona tiene `profiles.room` y `profiles.groups`; un *trigger* comprueba que sus grupos existan en la escuela. Se cambian con `save_school_hours`, `save_closure`, `add_school_groups`, `rename_school_group` y `remove_school_group` (permiso `calendar`), `set_my_room` (cada quien el suyo) y la función `admin` (salón y grupos de un empleado, borrar un día del calendario).

**Alertas:** `students` (nombre, grupo y `expires_at` a las 24 horas), `student_alerts` («No ha llegado»), `student_pickups` (salidas) y `relief_requests` (relevos), con reglas de seguridad por permiso (`security`), grupo y quién la creó; las vistas `student_alerts_v` y `student_pickups_v` añaden el nombre mientras exista. Todo se cambia con funciones SQL (`similar_students` con `pg_trgm`, `create_student_alert`, `resolve_student_alert`, `create_pickup`, `advance_pickup`, `request_relief`, `take_relief`, `cancel_relief`). Las notificaciones urgentes llevan `urgent` y `tag`: `pg_cron` las vuelve a enviar cada minuto (`private.repeat_urgent`) hasta que se abren o alguien se encarga (`private.close_notifications`), por 15 minutos; y cada hora la función `notify` borra los estudiantes vencidos y los avisos de alertas y turnos de más de 24 horas.

**Turnos:** `school_services` (cada servicio: modo `visit` o `room`, minutos para llegar, roles que lo atienden y motivos), `service_requests` (cada turno, con el nombre del estudiante para el historial del servicio), `service_request_details` (motivo y nota, aparte para que solo los lean quien lo pidió y el servicio) y `service_staff_status` (el estado de cada profesional). La vista `service_requests_v` añade el servicio, el motivo si se puede ver, y el nivel y el lugar en la fila (`private.turn_level`, `private.turn_position`). Todo se cambia con `request_service`, `advance_turn` (llamar, ya salió, llegó, regresa, llegó al salón, terminar, cancelar, está conmigo), `set_my_service_status`, `save_service` y `services_overview`. Cada minuto `pg_cron` revisa los temporizadores (`private.check_turn_timers`): si el estudiante llamado no llegó a tiempo, avisa al servicio y al maestro y crea la alerta «No ha llegado» para Seguridad (`student_alerts.turn_id`); al final del día cierra los turnos que nadie cerró.

**Solicitudes de mantenimiento:** `maintenance_requests` (qué, dónde, urgencia, nota, foto y cada paso con quién y cuándo), visible para quien la pidió y los permisos `maintenance` y `absences`; la vista `maintenance_requests_v` añade el lugar en la fila (`private.maintenance_position`: urgencia y llegada). Se cambian con `create_maintenance_request` (valida la foto, evita duplicados abiertos y limita a 20 por hora) y `advance_maintenance` (voy en camino, ya no puedo ir, listo, cancelar); `maintenance_overview` da quién atiende y cuántas hay. Las fotos se guardan en el bucket privado `maintenance/{escuela}/{persona}/` (5 MB, se reducen en el teléfono antes de subirlas) y se ven con enlaces temporales.

**Reservas del salón:** `room_bookings` (día, desde, hasta, para qué, estado y quién la pidió, aprobó, rechazó, canceló o reemplazó). Todos ven las pendientes y aprobadas de su escuela; las rechazadas, canceladas y reemplazadas solo quien las pidió y el permiso `calendar`. Una restricción de exclusión (`btree_gist`) impide en la propia base de datos que dos reservas aprobadas se crucen. Se cambian con `create_room_booking` (valida día de clases, horario y días sin clases; la secretaría y la dirección necesitan `p_replace` para quitarle la hora a otro), `decide_room_booking` y `cancel_room_booking`, que avisan con las horas libres del día (`private.room_free_text`). Reservar y aprobar van de uno en uno por escuela (`pg_advisory_xact_lock`), así dos personas no toman la misma hora a la vez.

**Paneles:** los paneles de servicio, mantenimiento y salón leen en el teléfono las filas que cada persona ya puede ver (las reglas de seguridad no cambian) y arman el Excel con `public/js/xlsx.js`. El tablero en vivo usa `live_board(p_since, p_today)`, que exige el permiso `reports` y devuelve el movimiento de hoy sin el motivo ni la nota de los turnos; el teléfono le dice cuándo empezó su día, porque la base de datos no conoce la zona horaria de la escuela. «Cerrar el año» de un servicio es la acción `close_service_year` de la función `admin`: solo quien atiende ese servicio (o Administración) borra los turnos terminados del período; los abiertos se quedan.

**Avisos:** al crear una notificación, un *trigger* la pone en la tabla `outbox` y `pg_net` llama a la función `notify`, que envía el push y/o el mensaje de Teams. Cada aviso se procesa una sola vez.

**Mantenimiento diario:** `pg_cron` (7:23 UTC) pone una tarea en `outbox` y `notify` borra las ausencias canceladas hace más de 15 días (con sus archivos), los registros de envío de más de 30 días, los avisos de más de 180 días, las fotos de mantenimiento 30 días después de cerrarse la solicitud (y las que se subieron sin llegar a usarse), y los mensajes, turnos, solicitudes de mantenimiento y reservas del salón de más de un año.

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
