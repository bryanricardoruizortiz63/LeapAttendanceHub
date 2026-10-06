# Plan: próximos módulos

Ideas y requisitos acordados para la siguiente etapa de la app. Nada de esto está construido todavía.
Las decisiones pendientes están al final.

---

## 0. Nombre y marca

- La app no debe parecer de una sola escuela. Cambiar el **nombre visible** (título, pantalla de entrada, nombre al
  instalar, correos, tarjetas de Teams). Los nombres internos no cambian.
- Ideas: **Plantel** (favorita), Presente, Pase, Aula Conecta. Verificar dominio y marca antes de decidir.
- Cambiar la dirección web **junto con un dominio propio** (renombrar el repositorio cambia la URL de GitHub Pages
  y rompe las apps instaladas y los enlaces de los correos).
- Marca blanca: cada escuela ve su nombre y su ícono; el producto queda en segundo plano («Escuela · con Plantel»).
- Los módulos nuevos van **dentro de la misma app**, y se activan o no por escuela (se pueden vender como complemento).

---

## 1. Turnos de servicios (Enfermería, Trabajo Social y otros)

**Lo que pidió la escuela**
- El maestro solicita un turno: estudiante, grado y grupo, situación y **gravedad**.
- Servicios: Enfermería, Trabajo Social y otros que se creen manualmente.
- La fila se ordena por orden de solicitud y gravedad. Se notifica cuándo le toca al estudiante.
- **Enfermería** (el estudiante va a la oficina):
  - la enfermera indica cuándo llegó el estudiante;
  - temporizador (ej. 5 minutos): si no llega, alerta de «no ha llegado»;
  - al regresar al salón, el maestro indica que llegó.
- **Trabajo Social** (la trabajadora social va al salón): mismo sistema de turnos según los maestros los apunten y la
  gravedad.
- Enfermeras y trabajadoras sociales:
  - ven los turnos y pueden escoger uno más prioritario;
  - avisan si en el momento están en una reunión u otra cosa.
- Al maestro le aparece el turno del estudiante y sabe cuándo le toca. Si el estudiante cambia de salón, el siguiente
  maestro ve sus turnos e historial para darle el pase.
- Cada maestro tiene asignados los **grados y grupos** en que da clase (ej. 9-B) y solo ve a esos estudiantes.
- Dashboard de Enfermería y Trabajo Social con **exportación** de datos no sensibles (cuántas veces vino, causa, día,
  hora…).
- Dashboard de la **directora** para ver **en vivo** el movimiento de Enfermería y Trabajo Social.
- **Seguridad** recibe la alerta si un estudiante que va a enfermería se pasa del tiempo.

**Propuesta**
- Servicios configurables:
  - modo: «el estudiante va» o «el profesional va al salón»;
  - niveles de gravedad editables;
  - tiempo de llegada;
  - rol que lo atiende.
- Lista de estudiantes importada desde Excel (nombre, grado-grupo, número) para que el historial no se divida por
  nombres mal escritos.
- Orden: gravedad primero y, dentro de cada nivel, orden de llegada. Los casos leves suben poco a poco para que no
  queden olvidados. El profesional puede escoger otro turno y queda registrado.
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

## 2. Códigos de mantenimiento

**Lo que pidió la escuela**
- Hoy se tiran **códigos** (ej. hay que mapear porque cayó un líquido en un salón).
- Cuando un maestro tira un código, a mantenimiento le llega una **notificación fuerte** al teléfono, que llame la
  atención y no suene bajo.
- Mantenimiento marca cuando **completó** la tarea y escoge la **próxima** por prioridad o por orden.

**Propuesta**
- Códigos configurables por escuela: nombre, color, descripción, prioridad y a quién avisa.
- El maestro elige el código y el salón, y puede añadir una nota o una foto.
- Fila de mantenimiento:
  - **En camino** → **Completado** → la app sugiere la siguiente;
  - el maestro recibe aviso cuando van en camino y cuando terminan.
- Panel: tiempos de respuesta, códigos por salón y por tipo, exportación a Excel.

---

## 3. Seguridad y pases

**Lo que pidió la escuela**
- Alerta si un estudiante que va a enfermería se pasa del tiempo (ver Turnos).
- **Pases**:
  - el maestro da permiso para ir al baño, a la oficina de la directora u otro lugar;
  - si el estudiante no aparece, se avisa a **seguridad y a todo el personal**.
- **Recogido de estudiantes**: si vienen a buscar a un estudiante, el maestro informa a seguridad con nombre y
  grado/grupo.

**Propuesta**
- Pase digital con destino y tiempo esperado; el maestro (o el destino) marca que llegó o regresó.
- Escalamiento en dos pasos, para evitar falsas alarmas:
  1. Al vencer, se avisa al maestro: puede extender el tiempo o marcar **No aparece**.
  2. Entonces se avisa a seguridad y a todo el personal con nombre, grado-grupo, destino y hora de salida. Si el maestro
     no responde en unos minutos, sube solo.
- Recogidos: lista «Salidas de hoy» para seguridad (estudiante, grado-grupo, quién lo recoge, hora); seguridad marca
  **Salió**.

---

## 4. Reserva del salón de conferencias

**Lo que pidió la escuela**
- Maestros y personal separan fechas para usar el salón de conferencias.
- La secretaria o la directora las **aprueban**.
- Las fechas que pone la directora o la secretaria tienen **prioridad** sobre las demás.

**Propuesta**
- Espacios configurables (salón de conferencias, y luego biblioteca, laboratorio, cancha…).
- Vista de calendario (semana/mes) sin choques entre reservas aprobadas.
- Las reservas de la directora o la secretaria se aprueban solas. Si chocan con la de otra persona, la otra se desplaza
  y se le avisa, con horarios libres sugeridos.
- Avisos al aprobar, rechazar o desplazar.

---

## 5. Notificaciones fuertes (límite técnico)

Una app web (PWA) **no puede** saltarse el modo silencioso ni poner una alarma propia:

- **Android**: notificación con vibración larga y que se queda en pantalla hasta tocarla. Suena con el sonido normal de
  notificaciones.
- **iPhone**: sonido normal de notificación, sin sonidos propios.
- **Con la app abierta**: alarma fuerte y pantalla de alerta hasta que alguien la reconozca.

Para que suene como alarma aunque el teléfono esté en silencio hace falta una **app nativa**:

- Android, con un canal de alarma.
- iPhone, con «alertas críticas», que Apple aprueba solo en algunos casos.
- Se puede empaquetar esta misma app (Capacitor). Cuesta USD 25 una vez en Google y USD 99 al año en Apple.

Otras opciones para lo urgente: **repetir el aviso cada minuto** hasta que alguien lo tome, Teams, o SMS/llamada
automática (con costo por mensaje).

---

## 6. Privacidad

- Son menores: el motivo se elige por categorías y la nota detallada solo la ve el servicio.
- No sustituye el expediente oficial de enfermería.
- Archivar y borrar al final del año, igual que las ausencias.
- Revisarlo con la política de privacidad estudiantil de la escuela (FERPA).

---

## 7. Fases sugeridas

1. Nombre nuevo (y dominio cuando lo haya).
2. Base común: grados y grupos, lista de estudiantes (Excel), grupos de cada maestro, permisos nuevos.
3. Turnos de Enfermería y Trabajo Social (fila, llamar, llegó, regresó, estado del profesional).
4. Temporizadores y alertas a seguridad; pases y «No aparece»; recogidos.
5. Códigos de mantenimiento.
6. Reservas del salón de conferencias.
7. Paneles con exportación a Excel y tablero en vivo de la directora.
8. *(Opcional)* Horario por períodos; app nativa para alarmas.

---

## Decisiones pendientes

1. Nombre: ¿cuál, o más ideas?
2. Estudiantes: ¿se importan desde Excel o los maestros los escriben?
3. Orden de turnos: ¿gravedad primero y luego orden de llegada?
4. Gravedad: ¿cuántos niveles y con qué nombres?
5. Grupos de cada maestro: ¿fijos o por período?
6. Códigos: ¿cuáles usan hoy y qué significa cada uno?
7. Salón del código: ¿cada maestro tiene un salón fijo o lo elige?
8. Pases:
   - ¿tiempo por destino?
   - ¿escalar solo o preguntar primero al maestro?
   - ¿avisar a todo el personal o solo a seguridad, dirección y los maestros del grupo?
9. Reservas:
   - ¿solo el salón de conferencias?
   - ¿por períodos o por horas?
   - ¿la reserva de la directora desplaza una ya aprobada?
10. Recogidos: ¿los informa el maestro o la oficina? ¿Seguridad confirma la salida?
11. Alarmas: ¿empezamos con la app web y más adelante vemos la app nativa?
