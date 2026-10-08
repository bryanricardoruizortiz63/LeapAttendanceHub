# Plan: próximos módulos

Ideas y requisitos acordados para la siguiente etapa de la app. Ya están hechos el nombre (Hallway), la base común,
las alertas y los turnos (ver la sección 9).

---

## 0. Nombre y marca

- La app no debe parecer de una sola escuela. Cambiar el **nombre visible** (título, pantalla de entrada, nombre al
  instalar, correos, tarjetas de Teams). Los nombres internos no cambian.
- **Nombre elegido: Hallway** (el pasillo, donde pasa todo el movimiento). La app sigue en español.
- Cambiar la dirección web **junto con un dominio propio** (renombrar el repositorio cambia la URL de GitHub Pages
  y rompe las apps instaladas y los enlaces de los correos).
- Marca blanca: cada escuela ve su nombre y su ícono; el producto queda en segundo plano («Escuela · con Hallway»).
- Los módulos nuevos van **dentro de la misma app**, y se activan o no por escuela (se pueden vender como complemento).

---

## 1. Base común: estudiantes, grupos y salones

- **Estudiantes**: no hay lista de estudiantes. Solo se guarda el estudiante que un maestro **apunta** para ir a algún
  lugar (turno, «No ha llegado», recogido), para que, si cambia de salón antes de que le toque, el otro maestro siga el
  progreso.
  - Esos datos se guardan **solo 24 horas**.
  - Si un maestro escribe un nombre **parecido** a uno apuntado ese día, la app pregunta: «¿Es José Pérez Rivera
    (9-B)?» → **Sí, es el mismo** / **No, es otro estudiante**.
- **Grupos de cada maestro**: fijos durante el año. Se revisan al empezar cada año escolar.
- **Salón de cada maestro**: va en su ficha y se usa por defecto. Se puede cambiar en el momento, porque algunos
  maestros cambian de salón.
- **Calendario escolar**: horario de **7:40 a. m. a 3:30 p. m., lunes a viernes**, y los días feriados o sin clases (los
  marca la secretaria o la directora). No se usan períodos.

**Hecho:** calendario escolar (horario, días de clases y días sin clases: *Feriado* o *Sin estudiantes*), grados y
grupos de la escuela, salón y grupos de cada persona, y el permiso nuevo **Calendario escolar** (Secretaría,
Director(a) y Administración). Al reportar una ausencia, la app avisa si ese día no hay clases.
Los estudiantes apuntados se hicieron junto con las alertas (sección 5): 24 horas y aviso de nombres parecidos en el
mismo grupo.

---

## 2. Turnos de servicios (Enfermería, Trabajo Social y otros)

**Lo que pidió la escuela**
- El maestro solicita un turno: estudiante, grado y grupo, situación y **gravedad**.
- Servicios: Enfermería, Trabajo Social y otros que se creen manualmente.
- Se notifica cuándo le toca al estudiante.
- **Enfermería** (el estudiante va a la oficina):
  - la enfermera indica cuándo llegó el estudiante;
  - temporizador (ej. 5 minutos): si no llega, alerta de «no ha llegado»;
  - al regresar al salón, el maestro indica que llegó.
- **Trabajo Social** (la trabajadora social va al salón): mismo sistema de turnos.
- Enfermeras y trabajadoras sociales:
  - ven los turnos y pueden escoger uno más prioritario;
  - avisan si en el momento están en una reunión u otra cosa.
- Al maestro le aparece el turno del estudiante y sabe cuándo le toca. Si el estudiante cambia de salón, el siguiente
  maestro ve sus turnos e historial para darle el pase.
- Cada maestro solo ve a los estudiantes de los **grados y grupos** en que da clase (ej. 9-B).
- Dashboard de Enfermería y Trabajo Social con **exportación** de datos no sensibles (cuántas veces vino, causa, día,
  hora…). **Decidido:** el servicio conserva el historial **con nombre durante el año escolar** y solo lo ve el propio
  servicio (enfermera o trabajadora social); los maestros lo ven solo 24 horas.
- Dashboard de la **directora** para ver **en vivo** el movimiento de Enfermería y Trabajo Social.
- **Seguridad** recibe la alerta si un estudiante que va a enfermería se pasa del tiempo.

**Decidido**
- Orden de la fila: **gravedad primero** y, dentro de cada nivel, **orden de llegada**. Los casos leves suben poco a
  poco para que no queden olvidados. El profesional puede escoger otro turno y queda registrado.
- **4 niveles de gravedad**: Baja, Media, Alta y Urgente.

**Propuesta**
- Servicios configurables:
  - modo: «el estudiante va» o «el profesional va al salón»;
  - tiempo de llegada;
  - rol que lo atiende.
- Flujo de enfermería:
  1. Llamar.
  2. Al maestro le llega «Envía a Juan (9-B)» y corre el tiempo.
  3. La enfermera marca **Llegó**.
  4. Si no llega a tiempo, avisan a la enfermera, al maestro y a seguridad.
  5. La enfermera marca **Regresa al salón**.
  6. El maestro marca **Llegó al salón**.
  7. Resultado: regresó, lo recogieron o fue referido.
- Flujo de trabajo social: **Voy en camino** → aviso al maestro → **Atendido**.
- Estado del profesional: Disponible, En reunión, Almuerzo, «Fuera hasta…».
- El maestro ve el estado del turno, **no el motivo**.

**Hecho**, en la pestaña **Turnos**:
- Servicios configurables (*Más → Servicios*): modo, minutos para llegar, roles que lo atienden y lista de motivos.
  Vienen Enfermería y Trabajo Social, con el rol nuevo **Trabajo Social**.
- Fila por gravedad y orden de llegada; cada 30 minutos de espera un turno sube un nivel (hasta Alta). Si el
  profesional escoge otro turno, queda anotado.
- Enfermería: Llamar → «Envía a Juan» (con alarma) → el maestro toca «Ya salió» → Llegó → Regresa al salón → el
  maestro toca «Llegó al salón»; o Lo recogieron / Referido. Si no llega a tiempo, se avisa a la enfermera, al
  maestro y a Seguridad (alerta «No ha llegado»). La enfermera anota también a quien llega sin turno.
- Trabajo Social: Voy en camino → Atendido o Referido.
- Si el estudiante cambia de salón, el maestro que lo tiene toca «Está conmigo» y los avisos le llegan a él.
- Después: el grupo del estudiante sale de los grupos asignados al maestro, y al llamarlo (o ir a buscarlo, o
  regresarlo) el aviso también les llega, sin alarma, a los otros maestros del grupo. «Está conmigo» también mientras
  Trabajo Social va en camino (le llega el salón nuevo).
- Después: el regreso al salón tiene el mismo tiempo para llegar; si nadie toca «Llegó al salón», alarma al maestro que
  lo envió, a los del grupo y al servicio, y alerta «No ha llegado» a Seguridad. Al maestro que lo envió le llega
  cuando otro lo recibe. Un regreso que nadie confirmó queda como «Regreso sin confirmar».
- Después: «Llamar» ya no empieza el tiempo para llegar (el estudiante todavía no ha salido); empieza con «Ya salió».
  Al llamar, el aviso les llega al maestro y a todos los maestros del grupo, y se les recuerda cada 3 minutos (cuatro
  veces) hasta que alguien toque «Ya salió» o «Está conmigo»; si nadie lo hace, se le avisa al servicio.
- El motivo y la nota solo los ven quien pidió el turno y el servicio. Los maestros ven los turnos de sus grupos
  24 horas; el servicio conserva su historial con nombre (como máximo un año) y ve las visitas anteriores de cada
  estudiante.
- **Hecho en la etapa de Paneles**: el panel de cada servicio con su Excel (sin las notas), el tablero en vivo de la
  directora (sin el motivo ni la nota) y «Cerrar el año»: el servicio descarga el Excel del período y borra los
  turnos terminados, para que el historial con nombres no pase al año siguiente.

---

## 3. Mantenimiento (sin códigos)

En la escuela solo se usa el **código naranja** (mantenimiento). En la app no hacen falta códigos: el maestro pide
directamente lo que necesita.

- El maestro envía una **solicitud a mantenimiento**:
  - tipo: derrame o líquido, limpieza, baño, basura, reparación, otro;
  - salón (el de su ficha, cambiable);
  - urgencia, y una nota o foto opcional.
- A mantenimiento le llega una **alerta fuerte** (ver sección 7).
- Fila de mantenimiento por **urgencia y orden de llegada**:
  - **En camino** → **Completado** → la app sugiere la siguiente;
  - el maestro recibe aviso cuando van en camino y cuando terminan.
- Panel: tiempos de respuesta y solicitudes por salón y por tipo, con exportación a Excel.

**Hecho**, con el permiso nuevo **Mantenimiento** (rol Mantenimiento y Administración):
- El maestro lo pide desde **Alertas → Mantenimiento**: qué hace falta, dónde (su salón, ya puesto), urgencia
  (Cuando puedan, Pronto, Urgente) y una nota o foto opcional. Si ya hay una abierta de lo mismo en el mismo lugar,
  la app lo dice en vez de repetirla.
- *Pronto* y *Urgente* llegan con alarma y se repiten cada minuto hasta que alguien las abre.
- El personal de Mantenimiento tiene la pestaña **Pedidos**: la fila por urgencia y llegada, **Voy en camino** (al
  maestro le llega quién va; al resto de Mantenimiento, que ya va alguien), **Listo** (con lo que se hizo) y la
  siguiente sugerida. Si quien iba no puede, **Ya no puedo ir** la devuelve a la fila.
- El maestro sigue sus solicitudes en *Alertas* y puede cancelarlas. La dirección y la secretaría ven todas.
- Las fotos son privadas y se borran 30 días después de cerrarse la solicitud; las solicitudes, al año.
- Como la directora no tiene el permiso Mantenimiento, se permite que quien administra el personal dé ese rol
  (es una tarea, no da acceso a datos de otros).
- **Hecho en la etapa de Paneles**: tiempos de respuesta, solicitudes por lugar, por tipo y por urgencia, y Excel.

---

## 4. Relevo de maestros

- El maestro toca **Pedir relevo** (cuando necesita ir al baño o salir un momento); el salón sale de su ficha.
- Les llega a los **maestros, la directora y la secretaria** (no a seguridad).
- Quien pueda toca **Yo lo relevo** y ya: no hay más pasos. Al maestro le llega quién va, y a los demás se les quita el
  aviso.

**Hecho.** Lo pueden pedir los roles que necesitan cobertura (maestros). Si nadie responde en 30 minutos, queda como
«Sin respuesta».

---

## 5. Seguridad: estudiante que no llega y recogidos

**Lo que pidió la escuela**
- Alerta a seguridad si un estudiante que va a enfermería se pasa del tiempo (ver Turnos).
- **Estudiante que no llegó**:
  - el maestro **no** registra cada salida al baño o a la oficina;
  - cuando un estudiante debía haber llegado al salón y no llegó, el maestro envía una alerta y **decide a quién**:
    **seguridad** (incluye a las directoras y la secretaria) o **todo el personal**.
- **Recogido de estudiantes**:
  1. El maestro informa que vendrán a recoger a un estudiante (nombre y grado/grupo).
  2. Cuando llega el padre o encargado, hay dos caminos: el maestro le avisa a seguridad, o seguridad le avisa al
     maestro que el padre o encargado llegó.
  3. Seguridad pasa al salón a recoger al estudiante.

**Propuesta**
- Botón **«No ha llegado»** para el maestro:
  - pide estudiante, grado-grupo y de dónde venía o a dónde iba (sin hora);
  - el maestro elige a quién avisar: **Seguridad** (seguridad, directoras y secretaria) o **Todo el personal**;
  - la alerta es urgente;
  - quien lo vea toca **«Apareció / está conmigo»**, y se avisa a todos que se resolvió;
  - queda un historial: quién avisó, cuánto tardó en aparecer y dónde estaba.
- Recogidos, con una lista **«Salidas de hoy»** para seguridad y para el maestro:
  - el maestro la anota antes (estudiante, grado-grupo y hora aproximada);
  - **Llegó el encargado**: lo marca seguridad (se avisa al maestro) o el maestro (se avisa a seguridad);
  - seguridad marca **Voy al salón** y luego **Entregado**; el maestro ve cada paso;
  - al entregar, seguridad puede anotar **quién lo recogió** (opcional).

**Hecho**, con el permiso nuevo **Seguridad** (Seguridad, Secretaría, Director(a) y Administración) y la pestaña
**Alertas**. Los avisos urgentes suenan con la app abierta y se repiten cada minuto por 15 minutos hasta que alguien
los abre o se encarga. La alerta a seguridad cuando un estudiante que va a enfermería se pasa del tiempo se hizo con
los Turnos.

---

## 6. Reserva del salón de conferencias

**Decidido**
- Solo el **salón de conferencias**.
- Se reserva por **horas** (de tal hora a tal hora). El horario escolar es de 7:40 a. m. a 3:30 p. m., lunes a viernes.
- Maestros y personal reservan; la **secretaria o la directora aprueban**.
- Las reservas de la directora o la secretaria tienen **prioridad** y se aprueban solas.
- Si la directora (o la secretaria) reserva encima de la reserva de un maestro, la app **le pregunta primero**:
  «Ya está reservado por X. ¿Quieres reemplazarla?». Si dice que sí, se cancela la del maestro y se le avisa.
- Al reservar, se le recuerda al maestro **verificar que el día no sea feriado ni día sin clases**. Los días marcados en
  el calendario escolar no se pueden reservar.

**Propuesta**
- Vista de calendario (semana/mes) sin choques entre reservas aprobadas.
- Avisos al aprobar, rechazar o reemplazar, con horarios libres sugeridos.

**Hecho**, en la pestaña *Reservas* (para todo el personal):
- Se reserva por horas, solo en días de clases y dentro del horario escolar; los días marcados en el calendario
  escolar no se pueden reservar y el formulario lo recuerda.
- Semana (con las horas libres de cada día y un botón para reservarlas) y mes (cuántas reservas tiene cada día).
- Aprueban la secretaría y la dirección (permiso *Calendario escolar*): les llega un aviso y en el *Panel* ven
  cuántas esperan. Al aprobar una, las otras pedidas para esa hora se rechazan solas. Quien no recibe la
  aprobación recibe el aviso con las horas libres de ese día.
- Sus propias reservas se aprueban solas. Encima de la de un maestro, la app pregunta «¿Reemplazar la reserva?»;
  si dicen que sí, se cancela la del maestro y se le avisa con las horas libres.
- Dos reservas aprobadas nunca chocan: lo impide la propia base de datos.
- Todo el personal ve para qué es cada reserva. Las reservas se borran al año.
- **Hecho en la etapa de Paneles**: uso del salón (horas, parte del horario de clases, por persona y por día) y Excel.
- **Notas**: al pedir se puede dejar una nota para la dirección, y en la reserva quien la pidió, la secretaría y la
  dirección conversan sobre ese día (cada nota les avisa a los demás). Solo ellos las ven.
- **Historial y canceladas**: las reservas por lo último que pasó (canceladas, no aprobadas, reemplazadas, aprobadas
  y por aprobar), con quién, cuándo y por qué; la secretaría y la dirección ven las de la escuela y los demás, las suyas.

---

## 7. Notificaciones fuertes (límite técnico)

Una app web (PWA) **no puede** saltarse el modo silencioso ni poner una alarma propia:

- **Android**: notificación con vibración larga y que se queda en pantalla hasta tocarla. Suena con el sonido normal de
  notificaciones.
- **iPhone**: sonido normal de notificación, sin sonidos propios.
- **Con la app abierta**: alarma fuerte y pantalla de alerta hasta que alguien la reconozca.
- Lo urgente **se repite cada minuto** hasta que alguien lo tome.

**Decidido:** subir la app a las tiendas se hace **al final**, cuando todo esté listo y probado. Con la app nativa:

- Android puede sonar como alarma con un canal de alarma.
- iPhone puede usar «alertas críticas», que Apple aprueba solo en algunos casos.
- Se empaqueta esta misma app (Capacitor). Cuesta USD 25 una vez en Google y USD 99 al año en Apple.

---

## 8. Privacidad

- Son menores: el motivo se elige por categorías y la nota detallada solo la ve el servicio.
- No sustituye el expediente oficial de enfermería.
- Los datos de estudiantes que siguen los maestros se borran a las **24 horas**.
- Enfermería y Trabajo Social guardan su propio historial con nombre durante el año escolar; solo lo ve ese servicio.
- Revisarlo con la política de privacidad estudiantil de la escuela (FERPA).

---

## 9. Orden de trabajo (aprobado)

1. **Nombre nuevo: Hallway** (y dominio cuando lo haya). *Hecho el nombre visible; falta el dominio.*
2. **Base común**: grupos y salón de cada maestro, calendario escolar (horario y feriados), permisos nuevos. *Hecho.*
3. **Alertas**: estudiantes apuntados (24 horas, con aviso de nombres parecidos), «No ha llegado», recogidos y relevo
   de maestros. *Hecho.*
4. **Turnos de Enfermería y Trabajo Social**: fila, llamar, llegó, regresó, temporizadores, estado del profesional y
   alerta a seguridad. *Hecho.*
5. **Mantenimiento**: solicitud con tipo, lugar, urgencia y foto; fila con En camino → Listo y la siguiente
   sugerida. *Hecho.*
6. **Reservas del salón de conferencias**: por horas, con aprobación, prioridad de la dirección y horas libres
   sugeridas. *Hecho.*
7. **Paneles** con exportación a Excel y **tablero en vivo** de la directora: panel de cada servicio (con «Cerrar el
   año»), de mantenimiento y del salón, y «En vivo» con Enfermería, Trabajo Social, alertas, salidas, relevos,
   mantenimiento y salón. *Hecho.*
   - Después: **navegación más clara**. La misma barra para todos (Ausencias, Alertas, Turnos, Reservas, Más; sin
     «Inicio» ni «Panel»), *Más* en grupos, la guía *Así está organizada Hallway* la primera vez y *Cómo usar
     Hallway* con «¿Dónde está…?». Y el formulario de turno ya no vuelve a preguntar el servicio. *Hecho.*
8. Al final, con todo listo: app nativa en las tiendas (alarmas fuertes).

---

## Decidido después

1. **Historial de Enfermería y Trabajo Social**: opción **b**. El servicio conserva el historial con nombre durante el
   año escolar y solo lo ve el propio servicio; los maestros, solo 24 horas. (Se descartaron: quitar el nombre a las
   24 horas, o borrarlo todo.)
