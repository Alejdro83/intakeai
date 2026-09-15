# Revisión de Virtualobby / IntakeAI

14 de septiembre de 2026 · Revisión técnica y recomendaciones para el hackatón AssemblyAI

La base del proyecto permite demostrar un recorrido útil: recepción por voz, lectura de documentos, preguntas configurables, confirmación y registro. Mi recomendación es concentrar el trabajo en la integridad del registro, la protección de sus datos y una demo de un único caso de uso. Ampliar los sectores o añadir integraciones antes de resolver estos puntos aumentaría el trabajo sin resolver los fallos que ya afectan al recorrido principal.

## Alcance y evidencia

- Repositorio privado revisado desde la sesión de GitHub del usuario. Referencia observada en la raíz: `6ea2dcecd9608c16bc0ca66d45f454bf2a082081`.
- Lectura completa de `api/worker.js`, `api/checkin-do.js`, `schema.sql`, `AGENTS.md` y README. Revisión del cliente `telegram/webapp/app.js` y de las secciones relevantes del panel `telegram/webapp/admin.html`.
- Apertura de la demo pública: llega a “Welcome to Demo Clinic” y pide un documento de identidad. No se concedieron permisos de micrófono, no se subieron documentos ni se completaron registros.
- Copias de lectura de los archivos estáticos publicados. Tras normalizar el salto de línea final, tamaño y huella FNV-1a coinciden con el texto de GitHub: app.js, 48.285 caracteres, `db43d5bb`; admin.html, 51.274 caracteres, `efb79bf7`. Es una comprobación de correspondencia del cliente, no una certificación criptográfica del despliegue del servidor.
- `node --check` del cliente publicado: correcto.
- Tres pruebas locales del cliente real, con DOM y WebSockets simulados y llamadas de red bloqueadas: las tres reproducen fallos, detallados abajo. No son pruebas completas de voz ni de infraestructura Cloudflare.
- No se modificó el proyecto, su configuración, sus despliegues ni sus datos. No se consultaron valores de secretos, registros de visitantes, documentos ni logs de producción.

## Lo que conservaría

1. **Máquina de estados en servidor.** Separar el progreso del registro de la conversación es una decisión útil; falta hacer que el protocolo entre ambos sea verificable.
2. **AssemblyAI integrado en el recorrido principal.** El cliente establece la sesión de voz y utiliza herramientas para capturar respuestas y correcciones.
3. **Clave del proveedor fuera del navegador.** El Worker emite credenciales temporales. El límite de solicitudes del endpoint de tokens utiliza una operación atómica en D1, una base mejor que un contador local por proceso.
4. **Configuración por negocio y webhook de salida.** Existe una vía para entregar el resultado a un sistema operativo real.
5. **Documentación de limitaciones.** El README reconoce carencias. Conviene mantener esa transparencia y actualizar lo que contradice el código actual.

## Hallazgos que corregiría primero

### 1. Bloqueante: las respuestas públicas incluyen el campo del secreto del webhook

**Evidencia:** [worker.js, líneas 267–295](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/worker.js#L267-L295) y [439–442](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/worker.js#L439-L442). Las rutas GET de listado, detalle y preguntas devuelven la fila completa de `businesses` sin autenticación. [El esquema](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/schema.sql#L18-L26) incluye `webhook_secret` en esa fila.

**Consecuencia:** si hay un secreto configurado y ese código está desplegado, un cliente público puede recibirlo. La firma HMAC deja de acreditar el origen frente a quien conozca ese valor. No se ha consultado el endpoint para obtenerlo ni se afirma que haya habido un incidente.

**Cambio recomendado:** construir respuestas públicas con una lista explícita de campos permitidos. Separar las rutas públicas de las administrativas; el panel puede mostrar “secreto configurado” sin recuperar el valor. Si hubo valores accesibles, revisar su exposición y rotarlos después de corregir la salida.

**Prueba de aceptación:** ninguna respuesta pública contiene claves de configuración privada, incluso con un negocio ficticio que tenga un secreto de prueba.

### 2. Alta: datos de visitantes se insertan como HTML en el panel

**Evidencia:** [admin.html, 1067–1088](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/admin.html#L1067-L1088) concatena respuestas y resultados de OCR en HTML. [app.js, 903–910](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/app.js#L903-L910) hace lo mismo con los campos de OCR.

**Consecuencia:** existe una vía de inyección de HTML y potencial XSS persistente cuando un administrador abre un registro con contenido manipulado. El servidor acepta texto desde el cliente; no basta con confiar en lo que produzca el modelo. Hallazgo estático, sin enviar cargas de ataque al despliegue.

**Cambio recomendado:** crear nodos y asignar datos mediante `textContent`; usar controles y manejadores de eventos en lugar de construir HTML con datos. Añadir una política CSP como protección complementaria. Para adjuntos, permitir tipos concretos, comprobar su contenido y evitar abrir contenido activo arbitrario en el contexto del sitio.

### 3. Alta: las correcciones del cuestionario no corresponden al comportamiento del servidor

**Evidencia:** [app.js, 745–759](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/app.js#L745-L759) permite corregir una respuesta llamando otra vez a `submit_answer`. Sin embargo, [checkin-do.js, 398–408](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/checkin-do.js#L398-L408) guarda cada texto en la pregunta situada en el índice actual y avanza. Cuando el estado es `confirming`, no aplica esa respuesta.

**Consecuencia:** una corrección durante las preguntas puede ocupar el campo siguiente; una corrección al final puede ser ignorada. El agente puede decir que ha corregido el dato mientras el registro conserva el anterior. Además, `validation_type` se transmite al cliente pero no se utiliza para validar la respuesta en esa ruta de servidor.

**Cambio recomendado:** enviar `question_id`, `operation_id`, `value` y la versión del estado. Distinguir entre responder y modificar una respuesta existente. Validar formato y obligatoriedad en el servidor. El resumen debe proceder del estado persistido, incluir etiquetas legibles y permitir editar cada campo.

**Prueba de aceptación:** responder, corregir una respuesta anterior, repetir una llamada y reconectar conserva exactamente los valores esperados. El webhook debe contener las mismas respuestas confirmadas.

### 4. Alta: el cliente comunica éxito antes de confirmar el guardado

**Evidencia:** [app.js, 643–671](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/app.js#L643-L671) añade un resultado positivo aunque el WebSocket del servidor no esté abierto. Tampoco deduplica las llamadas por `call_id`. Las operaciones se envían al servidor al recibir `tool.call`, antes de que se descarte un resultado por interrupción en [613–620](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/app.js#L613-L620).

**Pruebas locales realizadas:**

| Comportamiento esperado | Resultado observado |
|---|---|
| No anunciar éxito si el servidor está desconectado | Devuelve `success: true` con el socket cerrado |
| Procesar una vez una llamada repetida con el mismo ID | Envía dos mensajes al servidor |
| Restablecer el estado al iniciar otro visitante | `checkinDone` permanece en `true`, desactivando la reconexión del siguiente visitante |

El tercer defecto está en [app.js, 972–983](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/telegram/webapp/app.js#L972-L983), en combinación con las condiciones de reconexión.

**Cambio recomendado:** el servidor devuelve una confirmación asociada a la operación después de persistirla; sólo entonces se responde al modelo. Añadir deduplicación, manejo de errores, reenvío seguro y una función central que inicialice el estado completo de cada visitante. Una interrupción de audio debe tener una semántica definida respecto de una operación ya ejecutada.

### 5. Alta: falta validar la pertenencia y los límites de los archivos

**Evidencia:** [checkin-do.js, 78–106](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/checkin-do.js#L78-L106) permite subir mientras la sesión está en uno de dos estados, pero no impone límites propios de tamaño, cantidad o tipo real del archivo. En [261–275](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/checkin-do.js#L261-L275), `id_uploaded` acepta una clave R2 enviada por el cliente y la utiliza para leer el objeto sin verificar que se haya subido en esa sesión.

**Consecuencia:** comprobar el estado del formulario no equivale a autorizar el acceso al archivo. Si se conoce una clave de otro documento, falta el control que impediría usarla. La creación pública de sesiones permite entrar en el estado de subida; el límite de tokens de voz no limita esas subidas.

**Cambio recomendado:** registrar en el servidor las claves emitidas para cada sesión y negocio; consumir sólo esas claves. Limitar tamaño, número de documentos, solicitudes y duración. Validar el contenido del archivo y programar la eliminación de subidas abandonadas.

### 6. Alta: eliminación incompleta y contenido personal en logs

**Evidencia:** [worker.js, 363–370](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/worker.js#L363-L370) sólo borra la fila de D1. No borra la imagen ni los adjuntos de R2. [checkin-do.js, 303](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/checkin-do.js#L303) registra el valor de las correcciones; [363](https://github.com/Alejdro83/intakeai/blob/6ea2dcecd9608c16bc0ca66d45f454bf2a082081/api/checkin-do.js#L363) registra la respuesta OCR cuando no se puede interpretar. El cliente también registra campos OCR y respuestas.

**Cambio recomendado:** definir plazos de conservación por categoría y un proceso verificable de eliminación de D1, R2 y estado de sesión, con reintentos. Retirar valores personales de logs y dejar sólo metadatos de operación. Revisar por separado la conservación de audio y transcripciones por el proveedor: que el Worker no reciba audio no implica que el proveedor tampoco lo conserve. La [documentación de AssemblyAI](https://www.assemblyai.com/docs/voice-agents/voice-agent-api) describe artefactos de grabación y transcripción por sesión.

Para la demo, usar documentos y respuestas completamente ficticios. La experiencia clínica debería presentarse como recepción administrativa con revisión humana; el README menciona triaje, pero el código revisado implementa un cuestionario y un registro, no un sistema de triaje validado.

## Siguientes mejoras técnicas

- **Expiración real de sesiones.** La única llamada a `setAlarm` está en `webSocketOpen`, que no se llama desde el archivo y no es uno de los callbacks documentados de la API de hibernación usada con `acceptWebSocket`. Mover la inicialización al punto de aceptación o de inicio de sesión. Es una conclusión de código y [documentación de Cloudflare](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/), pendiente de prueba en su runtime.
- **Entrega fiable al sistema del negocio.** `_fireWebhook` hace un intento y registra el fallo. Guardar el evento pendiente de entrega, reintentar con espera creciente y hacer deduplicación por `registration_id` en el receptor. Mostrar “registro guardado” y “entrega al sistema pendiente/completada” como estados distintos.
- **Contrato estable de respuestas.** Hoy se guardan respuestas por IDs de preguntas y el panel busca sus textos en la configuración actual. Conservar una versión del cuestionario y las etiquetas/campos que correspondían al registro para que una edición posterior no vuelva incomprensible el histórico.
- **Permisos por negocio.** `requireAdmin` autoriza por una lista global de Telegram IDs. Antes de ofrecerlo a organizaciones independientes, comprobar el negocio permitido en cada operación y registrar quién realizó cambios.
- **Reconexión de voz.** Hay recuperación del WebSocket de estado; el cierre del de AssemblyAI deja un mensaje y no reconstruye la sesión de voz. Añadir reanudación coherente y entrada por texto para completar el recorrido si falla el audio.
- **Documentación coherente.** `AGENTS.md` sigue describiendo el starter de Python. El README describe principalmente Cloudflare y sólo dos herramientas, pero el cliente publicado incluye `confirm_registration`. Alinear instrucciones, arquitectura y pasos de reproducción con lo que realmente se entrega.

## Cómo lo presentaría en el hackatón

Las bases permiten Voice Agent API o STT en tiempo real con orquestación propia. Evalúan aplicación de tecnología, presentación, valor de negocio y originalidad. Piden repositorio público, aplicación accesible, vídeo, presentación y descripción. El cierre visible es el **30 de septiembre de 2026 a las 17:00 CEST**. El repositorio revisado es privado: preparar una versión pública revisada forma parte de la entrega; no se ha cambiado su visibilidad. [Bases oficiales](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/).

### Mensaje de producto

Propuesta: **“Una recepción por voz que convierte lo que dice el visitante en un registro confirmado y listo para el equipo.”**

Elegir un vertical para la presentación. Si aprovecháis experiencia de salud mental, una recepción administrativa de clínica puede dar contexto concreto; evitaría promesas diagnósticas o de triaje. Las plantillas de hotel, despacho y eventos pueden quedar como capacidad futura de configuración.

El diferenciador que desarrollaría es una ficha verificable: cada campo muestra el valor, de dónde salió —voz, OCR o edición— y si el visitante lo confirmó. Conservar el vínculo con la fuente dentro de la política de conservación elegida. Los campos inciertos deben pedir aclaración y admitir “no aportado”.

### Demo propuesta, de unos tres minutos

1. Presentar al usuario concreto, el trabajo que necesita completar y el resultado esperado.
2. Pulsar “Probar con datos ficticios”. Introducir el micrófono tras una acción explícita y explicar brevemente qué se procesa. Ofrecer también un recorrido de ejemplo que no lo necesite.
3. Mostrar un documento ficticio con un error de lectura previsto y corregirlo por voz.
4. Contestar una pregunta, interrumpir y corregir una respuesta anterior. Mostrar que se actualiza el campo correcto.
5. Confirmar una ficha legible y enseñar el registro guardado y la entrega a un receptor de demostración. Identificar claramente las partes simuladas.
6. Mostrar dos o tres métricas reales y el papel de AssemblyAI en el recorrido.

No atribuir a OCR la verificación de autenticidad o identidad: leer los campos de una imagen no demuestra que el documento sea auténtico ni que pertenezca al visitante.

### Qué medir

Usar diez escenarios sintéticos al principio: recorrido normal, documento ilegible, corrección de nombre, corrección de una respuesta anterior, interrupción, silencio, micrófono denegado, caída de conexión, llamada duplicada y segundo visitante. Añadir la variante con adjuntos antes de mostrarla.

Medir finalización del registro, exactitud de campos frente al guion, correcciones persistidas, duplicados, tiempo hasta la primera respuesta audible y coste por registro completado. Publicar número de pruebas y condiciones. Cualquier objetivo de latencia debe presentarse como objetivo hasta que exista una medición real; esta revisión no midió latencia de voz, precisión OCR ni coste real.

## Orden de trabajo recomendado

1. **Cerrar los bloqueantes:** respuestas públicas sin secretos, renderizado seguro, pertenencia de documentos, registros sin contenido personal en logs.
2. **Asegurar integridad:** operaciones identificadas, confirmación de persistencia, corrección por campo, deduplicación y restablecimiento de sesiones. Convertir los tres fallos reproducidos en pruebas que deban pasar.
3. **Completar fiabilidad:** conservación y eliminación, expiración, reintentos del webhook y recuperación de voz.
4. **Preparar entrega:** un caso de uso, entrada con datos ficticios, ficha verificable, métricas, vídeo y documentación de reproducción. Revisar el contenido antes de publicar el repositorio.

La evidencia disponible permite recomendar estas correcciones con referencias concretas. No permite afirmar que todos los fallos del repositorio estén presentes en el servidor desplegado ni sustituye una prueba completa del agente con audio.
