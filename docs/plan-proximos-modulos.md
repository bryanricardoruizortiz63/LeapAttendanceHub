# Plan: próximos módulos

Ideas y requisitos acordados para la siguiente etapa de la app. Nada de esto está construido todavía.
Lo que falta decidir está al final.

---

## 0. Nombre y marca

- La app no debe parecer de una sola escuela. Cambiar el **nombre visible** (título, pantalla de entrada, nombre al
  instalar, correos, tarjetas de Teams). Los nombres internos no cambian.
- El nombre será **en inglés**; la app sigue en español. Ideas (verificar dominio y marca antes de decidir):
  - **Hallway**: el pasillo, donde pasa todo el movimiento (turnos, relevos, recogidos, alertas).
  - **Campus Pulse**: el pulso de la escuela en vivo.
  - **Bellwise**: de *bell*, el timbre escolar.
  - **OnCampus**.
  - **Rollcall**: pase de lista.
  - **SchoolBeat**.
  - **Corridor**.
  - Evitar nombres ya usados en educación: e-hallpass/SmartPass, ClassPass, Homebase, Relay, StaffHub.
- Cambiar la dirección web **junto con un dominio propio** (renombrar el repositorio cambia la URL de GitHub Pages
  y rompe las apps instaladas y los enlaces de los correos).
- Marca blanca: cada escuela ve su nombre y su ícono; el producto queda en segundo plano («Escuela · con Hallway»).
- Los módulos nuevos van **dentro de la misma app**, y se activan o no por escuela (se pueden vender como complemento).

---

## 1. Base común: estudiantes, grupos y salones

- **Estudiantes**: no se importa una lista. El maestro **escribe el nombre** y la app lo **va guardando**.
  - Al escribir aparecen sugerencias de los estudiantes ya guardados (del grupo elegido primero).
  - Si escribe un nombre **parecido** a uno guardado (acentos, una letra, nombre incompleto), la app pregunta:
    «¿Es José Pérez Rivera (9-B)?» → **Sí, es el mismo** / **No, es otro estudiante**.
  - Administración puede unir duplicados que se hayan colado.
  - Si un estudiante cambia de grupo, se le actualiza y su historial se conserva.
- **Grupos de cada maestro**: fijos durante el año. Se revisan al empezar cada año escolar.
- **Salón de cada maestro**: va en su ficha y se usa por defecto. Se puede cambiar en el momento, porque algunos
  maestros cambian de salón.
- **Calendario escolar**: horario de clases de **7:40 a. m. a 3:30 p. m., lunes a viernes**, con sus **períodos**, y
  los días feriados o sin clases (los marca la secretaria o la directora).

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
  hora…).
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

---

## 4. Relevo de maestros

**Lo que pidió la escuela**
- Un maestro pide **relevo** cuando necesita ir al baño o salir un momento.
- Quien lo cubre avisa por la app.

**Propuesta**
- El maestro toca **Pedir relevo** (motivo opcional: baño, salir un momento, otro); el salón sale de su ficha.
- Les llega a las personas que pueden cubrir. La primera que toca **Voy** lo toma, y a los demás se les quita el aviso.
- Quien cubre marca **Llegué / estoy cubriendo**. Cuando el maestro regresa, cualquiera de los dos marca **Terminado**.
- Si nadie lo toma en unos minutos, se vuelve a avisar y luego se avisa a dirección.

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

---

## 6. Reserva del salón de conferencias

**Decidido**
- Solo el **salón de conferencias**.
- Se reserva por **períodos de clase** (horario de 7:40 a. m. a 3:30 p. m., lunes a viernes) o por **horas libres**.
- Maestros y personal reservan; la **secretaria o la directora aprueban**.
- Las reservas de la directora o la secretaria tienen **prioridad** y se aprueban solas.
- Si la directora (o la secretaria) reserva encima de la reserva de un maestro, la app **le pregunta primero**:
  «Ya está reservado por X. ¿Quieres reemplazarla?». Si dice que sí, se cancela la del maestro y se le avisa.
- Al reservar, se le recuerda al maestro **verificar que el día no sea feriado ni día sin clases**. Los días marcados en
  el calendario escolar no se pueden reservar.

**Propuesta**
- Vista de calendario (semana/mes) sin choques entre reservas aprobadas.
- Avisos al aprobar, rechazar o reemplazar, con horarios libres sugeridos.

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
- Archivar y borrar al final del año, igual que las ausencias.
- Revisarlo con la política de privacidad estudiantil de la escuela (FERPA).

---

## 9. Orden de trabajo propuesto

1. **Nombre nuevo** (y dominio cuando lo haya).
2. **Base común**: estudiantes que se guardan solos con aviso de nombres parecidos, grupos y salón de cada maestro,
   calendario escolar (períodos y feriados), permisos nuevos.
3. **Seguridad**: «No ha llegado», recogidos y **relevo de maestros**. Es lo más sencillo y lo que más ayuda en el día a
   día.
4. **Turnos de Enfermería y Trabajo Social**: fila, llamar, llegó, regresó, temporizadores, estado del profesional y
   alerta a seguridad.
5. **Mantenimiento**.
6. **Reservas del salón de conferencias**.
7. **Paneles** con exportación a Excel y **tablero en vivo** de la directora.
8. Al final, con todo listo: app nativa en las tiendas (alarmas fuertes).

---

## Falta decidir

1. **Nombre**: ¿cuál de la lista de la sección 0, o más ideas?
2. **Relevo**: ¿a quién le llega la petición (todo el personal, maestros en período libre, un rol como «Relevo» o
   «Asistente»)?
3. **Períodos**: ¿cuáles son las horas de cada período? (también se podrán editar en la app).
4. **Mantenimiento**: ¿sirven esos tipos de solicitud (derrame, limpieza, baño, basura, reparación, otro)?
5. **Orden de trabajo**: ¿te parece bien el de la sección 9?
