# Virtualobby: comprobación de la demo y encaje con las bases

**Fecha:** 15 de septiembre de 2026. **Alcance del PR:** documentar evidencias, correcciones pendientes y criterios de aceptación. Las correcciones no se implementan en este documento.

## 1. Conclusión sobre la corrección propuesta

**Sí: añadir inicio explícito de audio, reintento, recuperación de sesión y una alternativa escrita auxiliar es compatible con el enfoque publicado del hackatón, conservando AssemblyAI Voice Agent API como núcleo del agente.** Esta es una conclusión razonada a partir de las fuentes consultadas, no una certificación del organizador ni una validación de todos los requisitos de entrega.

Las [bases del evento](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/) admiten Voice Agent API o Realtime Speech-to-Text con orquestación propia. Evalúan integración tecnológica, presentación, valor de negocio y originalidad. En sus secciones Challenge, Guidelines y Judging criteria, y en el [reglamento general enlazado](https://lablab.ai/hackathon-rules), no se encontró una exigencia de interfaz exclusivamente oral ni una prohibición de botones o entrada escrita auxiliar. La rúbrica técnica general valora que la demo funcione; resolver este bloqueo apoya ese criterio, sin garantizar una puntuación.

| Propuesta | Encaje y condición |
| --- | --- |
| Botón «Iniciar conversación» | La [guía oficial de integración web de AssemblyAI](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration#cross-browser-checklist) recomienda activar el audio desde una interacción del usuario; su ejemplo incluye un botón de inicio. El botón habilita la conversación de voz. |
| Reintento y recuperación | Conservan la misma integración. La [referencia de eventos](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference) documenta `session.resume` para recuperar una sesión de voz dentro de una ventana de 30 segundos. El progreso del registro necesita recuperación propia. |
| Respuesta escrita auxiliar | Debe mostrarse como modo de apoyo cuando la voz falla o no puede usarse. La API documenta `conversation.message` y `reply.create`, pero una alternativa local también debe respetar las validaciones del registro. No debe presentarse una demo sólo escrita como prueba de que la voz funciona. |

**Condición de entrega propuesta por esta revisión:** demostrar al menos un recorrido real de voz con AssemblyAI hasta la confirmación y verificar el registro guardado. Es un criterio técnico de aceptación del equipo; no una cifra ni un escenario literalmente exigidos por las bases.

### Puntos de entrega que siguen pendientes

- El evento exige repositorio público, URL de aplicación, vídeo y presentación. El repositorio sigue marcado como privado en la comprobación de hoy; este PR no cambia su visibilidad. También se exige originalidad y compatibilidad con MIT. No se ha auditado aquí toda la entrega ni sus licencias.
- El cierre publicado es el **30 de septiembre de 2026 a las 17:00 CEST**.
- **Alojamiento por confirmar:** el reglamento general, en Application Components, menciona Streamlit, Replit o Vercel. La página específica solicita plataforma y URL sin repetir esa lista; la demo actual usa Cloudflare Pages/Workers. Pedir aclaración al organizador sobre Cloudflare antes de considerar validada toda la entrega. Esta incertidumbre es independiente del arreglo del audio y no obliga por sí sola a migrar la arquitectura.

## 2. Entorno, trazabilidad y límites de la prueba

- Demo: [Virtualobby](https://intakeai-col.pages.dev/).
- Navegador: integrado de Codex. Prueba realizada el 15/09/2026, aproximadamente entre 12:09 y 12:13 CEST.
- Dos cargas de página y una subida de imagen, rotulada explícitamente como documento sintético sin validez y con datos ficticios. No se capturó audio ni se concedió permiso de micrófono.
- Se descargó el `app.js` publicado durante la prueba. SHA-256 del archivo: `0cc0c02e88614f32b2df0a6e96e5b19c2ab2ca2ba292d8b4aa2ce2b919fb30ad`.
- Se contrastó su texto con `telegram/webapp/app.js` de `main`, cuya referencia observada es [3548f9e6550593e37a9cb389f3bad16815e6f484](https://github.com/Alejdro83/intakeai/commit/3548f9e6550593e37a9cb389f3bad16815e6f484): coinciden tras normalizar saltos de línea y el salto final. Los enlaces al código de este informe usan esa referencia fija.
- `node --check` del cliente descargado terminó correctamente. No detecta ni descarta errores de ejecución o de integración.
- No se completó la entrevista ni se verificó su persistencia final, webhook, correcciones por voz o segundo visitante. El comportamiento no se extrapola a todos los navegadores o a Telegram.

## 3. Pasos y resultados reproducidos

| Paso | Resultado observado |
| --- | --- |
| Abrir la URL y esperar | Aparece Demo Clinic y la solicitud de documento. El token devuelve HTTP 200. |
| Esperar la voz | Los dos contextos de audio quedan en `suspended`; no aparece el log de resolución de `resume()` ni la llamada a `getUserMedia`. |
| Pulsar Upload File y subir la imagen sintética | La subida funciona; este clic no recupera el arranque de voz pendiente. |
| Esperar el OCR | El servidor devuelve tres campos ficticios y `success: true`. Transcurren unos 3,3 s desde el inicio de subida hasta el resultado, en una única muestra. No es latencia de voz. |
| Entrar en la entrevista | Se muestra la pregunta 1/5. No hay respuesta escrita ni reintento de voz visible. La sesión permanece bloqueada. |
| Recargar | Se vuelve a solicitar el documento y se repite el estado de audio suspendido. |

Extracto mínimo de los logs, sin tokens, identificadores de sesión ni claves de archivos:

```text
12:09:35 Token response status: 200
12:09:35 captureCtx.state=suspended playbackCtx.state=suspended
12:11:38 STATUS: Uploading...
12:11:41 OCR result received, success=true
12:11:41 scanCompleted=true aaiReady=false voiceConnecting=true
12:11:41 Voice is connecting — interview handoff will happen on session.ready
12:11:41 Question state: 1/5: Do you have an appointment today?
12:12:28 Token response status: 200
12:12:28 captureCtx.state=suspended playbackCtx.state=suspended
```

La subida sintética quedó almacenada según la confirmación del servidor. No se confirmó un registro final ni se eliminó la subida. El OCR demuestra lectura de texto; no verificación de identidad.

## 4. Errores a corregir, por prioridad

### V1 — Alta: el arranque de voz queda pendiente sin salida

**Evidencia:** [arranque automático al recibir welcome](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L277); [`voiceConnecting` y creación/activación del audio](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L417-L479). Las esperas de las líneas 458–459 ocurren antes de pedir el micrófono y carecen de una salida visible por tiempo agotado.

**Diagnóstico:** los logs se detienen en el punto previsto por el código. Es consistente con las restricciones de autoplay descritas por [Chrome](https://developer.chrome.com/blog/web-audio-autoplay) y con la guía web de AssemblyAI. El token 200 y la ausencia de inicio de voz no permiten atribuir el fallo a una caída del proveedor.

**Cambio recomendado:** crear/reanudar los contextos directamente desde el clic de inicio, antes de esperas de red que puedan perder la activación del usuario. Mostrar estados de activación, permiso, conexión y error; permitir reintentar. Evitar intentos simultáneos, liberar audio/micrófono de intentos fallidos y no dejar `voiceConnecting` bloqueado. Obtener un token nuevo cerca de cada apertura de conexión, conforme a su uso único documentado.

**Criterios de aceptación pendientes:**

- [ ] En una sesión de navegador sin permisos previos, el clic de inicio permite avanzar a la solicitud del micrófono; con permiso y dispositivo válidos se recibe `session.ready` y se oye al agente.
- [ ] Denegar o demorar el permiso, o fallar el token/conexión, produce un mensaje y una vía de reintento; no una espera indefinida.
- [ ] Dos clics rápidos no crean dos capturas o conexiones; los recursos de un intento abandonado se liberan, incluso si el permiso termina resolviéndose tarde.

### V2 — Alta: la entrevista se muestra aunque la voz no esté disponible

**Evidencia:** [transición al recibir preguntas](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L296-L304) y [espera del cambio a entrevista](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L811-L827). La UI muestra la primera pregunta, pero `aaiReady=false` y `voiceConnecting=true` impiden una conversación utilizable. Los [controles existentes](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L966-L1009) no ofrecen reintento ni entrada escrita de respuestas.

**Cambio recomendado:** separar pregunta y estado de conexión. Ofrecer activar/reintentar voz y un modo escrito identificado como auxiliar. Las respuestas de ambos modos deben recorrer las mismas validaciones, identificar la pregunta y confirmar el guardado con el servidor; evitar envíos dobles al alternar modos. Si existe conexión de voz, evaluar los eventos de texto documentados; si no existe, el modo escrito necesita una ruta de aplicación independiente y explícita. No simular transcripción ni afirmar que AssemblyAI procesó texto que no recibió.

**Criterios de aceptación pendientes:**

- [ ] Con OCR terminado y voz bloqueada, se muestra la causa y una acción disponible.
- [ ] Una respuesta escrita válida hace avanzar exactamente una pregunta tras la confirmación del servidor.
- [ ] Al recuperar voz, agente e interfaz usan el mismo progreso, sin repetir ni perder respuestas.
- [ ] El recorrido habitual sigue siendo una conversación real con AssemblyAI; la demo diferencia cualquier modo auxiliar o parte simulada.

### V3 — Media: recargar pierde la continuidad del recorrido

**Evidencia:** [`connectToDO()` genera un UUID nuevo](https://github.com/Alejdro83/intakeai/blob/3548f9e6550593e37a9cb389f3bad16815e6f484/telegram/webapp/app.js#L244-L257). La reconexión del socket en memoria reutiliza la sesión, pero la carga completa de página inicia otra. Se reprodujo la vuelta al documento desde la primera pregunta. Es una carencia de recuperación, no una afirmación de pérdida o borrado de datos en D1/R2.

**Cambio recomendado:** recuperar el registro en curso mediante una referencia temporal autorizada y caducable, consultando al servidor el estado válido; no guardar datos de documentos en el navegador para resolverlo. Separar la continuidad del registro de la sesión de voz. `session.resume` sólo cubre su ventana documentada de 30 segundos: tras expirar, iniciar otra sesión de voz con el contexto mínimo autorizado. En un dispositivo compartido, finalizar/reiniciar debe impedir que el siguiente visitante recupere el anterior.

**Criterios de aceptación pendientes:**

- [ ] Recargar tras OCR recupera el mismo paso cuando la sesión administrativa sigue vigente y autorizada.
- [ ] Una sesión caducada explica por qué debe reiniciarse y no muestra información anterior.
- [ ] Una reconexión breve de voz y otra fuera de su ventana se gestionan de forma distinta; ninguna duplica respuestas ni registros.
- [ ] Al empezar otro visitante, no queda acceso al progreso del anterior.

## 5. Verificación final antes de cerrar estos errores

Probar con datos ficticios: primera visita, permiso denegado, permiso tardío, token fallido, clic repetido, OCR antes de voz, respuesta escrita, recuperación de voz y recarga. Después completar las cinco preguntas, revisar/corregir el resumen, confirmar una sola vez y contrastar el registro guardado. Repetir el recorrido principal en Chrome/Edge, Safari/iOS y el WebView de Telegram si se anuncian como compatibles. Estos escenarios están pendientes; no se presentan como pruebas ya superadas.

El cliente actual ya incluye un botón manual de confirmación del resumen. Debe verificarse cuando se alcance ese paso, no proponerse de nuevo como si no existiera. Esta validación de la demo complementa la revisión general del PR #1; no sustituye sus hallazgos de seguridad ni declara corregidos los fallos de aquel informe.
