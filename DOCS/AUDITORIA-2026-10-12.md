# Auditoría de Black Cobble (12 de octubre de 2026)

Versión del paquete: 0.1.1. Código revisado: commit `f3177e98a5c8ff0948f0a59843881a5087b05b25`, en la rama `feat/busqueda-global`. El árbol de trabajo estaba limpio al empezar y al terminar. Esta auditoría solo documenta: no corrige la aplicación ni actualiza dependencias.

Es la segunda auditoría del proyecto. La anterior es [AUDITORIA-CERRADA.md](AUDITORIA-CERRADA.md), del 9 de octubre y el commit `3cede7c`. Desde entonces se han añadido la búsqueda y el reemplazo global, el menú contextual del árbol, la alineación por bloque en las notas HTML y el empaquetado para Linux. Son 47 archivos y unas 3.700 líneas.

## Resultado

La compilación, el typecheck, 221 pruebas unitarias (3 omitidas) y las 27 pruebas E2E en Electron pasan. Aparecen **15 problemas nuevos** que las pruebas no detectan. Cada uno se verificó de forma cruzada, y los 15 quedaron confirmados sin falsos positivos.

De la auditoría anterior, **F01, F03, F04, F05 y F07 están corregidos**. Tres de esas correcciones dejan problemas residuales menores, y la de F03 introdujo la regresión GS01. **F02 está corregido en parte. F06, F08 y F09 siguen abiertos**, igual que las observaciones O01, O02, O09 y O10.

Ningún problema permite ejecutar código desde una nota ni filtra contenido privado. Los dos más graves son un bloqueo de acceso (GS01) y una escritura confirmada que se pierde (GS04). Ambos necesitan condiciones poco frecuentes.

| ID | Prioridad | Problema | Verificación cruzada |
| --- | --- | --- | --- |
| GS01 | P1 | Tras cambiar la contraseña con una recuperación pendiente, la bóveda privada no se abre con ninguna contraseña | Reproducido por la vía real (Claude) |
| GS04 | P2 | Dos instancias de la app sobre la misma bóveda privada pueden perder una escritura que se dio por guardada | Reproducido 3 de 3 (Claude) |
| CR01 | P2 | Renombrar una nota rompe los wikilinks escapados dentro de tablas (`[[Nota\|alias]]`) | Reproducido (GPT) |
| CR02 | P2 | Las notas con `#` en el nombre generan enlaces que apuntan a otra nota o a ninguna | Reproducido (GPT) |
| GB01 | P2 | Una regex del usuario se vuelve a ejecutar en el renderer, fuera del worker con límite de tiempo, y puede colgar la interfaz | Reproducido (Claude) |
| GB03 | P2 | «Reemplazar todo» puede reemplazar más coincidencias de las confirmadas si los resultados se refrescan con el diálogo abierto | Simulado con funciones reales (Claude) |
| CR03 | P2 | Coste de resolver wikilinks por pulsación en bóvedas grandes (amplía O01 y O02) | Medido (GPT) |
| GS02 | P3 | Renombrar puede dejar una nota cerca de 32 MiB por encima del límite de lectura | Reproducido (Claude) |
| GS03 | P3 | Si el reloj retrocede, la sesión privada se mantiene abierta más tiempo | Reproducido (Claude) |
| GB02 | P3 | «Solo palabras completas» no tiene en cuenta que una palabra puede seguir en otro nodo HTML | Reproducido (Claude) |
| GB04 | P3 | Una nota que agota el tiempo o la memoria del worker se omite sin avisar | Reproducido (Claude) |
| CR04 | P3 | En un HTML sin `<body>` explícito se añade una línea en blanco en cada ciclo de edición | Reproducido (GPT) |
| CR05 | P3 | Al editar un HTML con `<frameset>` se pierden doctype, head y frameset | Reproducido sin interfaz (GPT) |
| CR06 | P3 | Al cambiar de vista HTML, los cambios externos acumulados se pueden deshacer junto con la edición del usuario | Reproducido sin interfaz (GPT) |
| CR07 | P3 | En la vista de código HTML, abrir un enlace a un encabezado no salta a él | Ejecución aislada del efecto (GPT) |

Las prioridades son las mismas que en la auditoría anterior. **P1:** pérdida de acceso o de datos que conviene resolver antes de distribuir otra versión. **P2:** error funcional o de disponibilidad con condiciones concretas y realistas. **P3:** casos límite, mantenimiento o impacto menor.

## Método

La auditoría se hizo en colaboración entre Claude y GPT, siguiendo `~/.agents/CONTRATO.md` y la skill compartida `gpt-sol-collaboration`. Coordinó Claude Opus 5.5. Cada auditor trabajó en solo lectura sobre un área distinta. Después, cada hallazgo lo verificó un agente **del otro proveedor**.

| Fase | Agente | Área | Duración |
| --- | --- | --- | --- |
| Auditoría | GPT-6.1 Sol (high) | Proceso principal de Electron, IPC, almacenamiento, cifrado y sesión (GS) | 7,3 min |
| Auditoría | GPT-6.1 Sol (high) | Búsqueda y reemplazo global (GB) | 5,3 min |
| Auditoría | Claude Opus 5.5 | Renderer: App, editores Markdown/HTML, wikilinks y componentes (CR) | 11,5 min |
| Verificación | Claude Opus 5.5 | Reproducción de GS01–GS04 y GB01–GB04 | 7,0 min |
| Verificación | GPT-6.1 Sol (high) | Reproducción de CR01–CR07 | 7,7 min |
| Línea base | Coordinador | Typecheck, pruebas unitarias, build y E2E | ~2,5 min |

Las reproducciones usaron bóvedas temporales y funciones de las fuentes compiladas en memoria o en el directorio temporal de la sesión. No se escribió nada en el repositorio. No se usó la red, así que el aviso de F09 no se volvió a consultar en el registro npm.

## Hallazgos

Las referencias `archivo:línea` corresponden al commit indicado.

### GS01. El cambio de contraseña bloquea la bóveda privada si hay recuperaciones pendientes (P1)

Referencias: `electron/encrypted-vault.ts:209` y `electron/encrypted-vault.ts:371`.

Al desbloquear, una recuperación que no cabe se deja pendiente (`recoveryPending`), que es la corrección de F03. Al cambiar la contraseña solo se vuelve a envolver la clave del contenedor principal. El archivo `recovery-*.sealed` sigue envuelto con la contraseña anterior, y la importación lo desenvuelve con la contraseña tecleada (`unwrapKey`) **antes** de abrir la sesión. Después de bloquear, la contraseña nueva falla con el recovery y la antigua falla con el contenedor. Las dos muestran «Contraseña incorrecta o datos cifrados dañados.», también tras reiniciar.

Escenario reproducido sin fabricar archivos: A guarda una nota de 9 MiB, B la sustituye por otros 9 MiB, el borrador de A queda en conflicto y se crea el recovery. Después se cambia la contraseña y se bloquea. Si se aparta el recovery a mano, la bóveda vuelve a abrir, porque la clave de datos no cambia. No hay pérdida de datos, pero el usuario no tiene forma de saber cómo recuperar el acceso.

Corrección propuesta: descifrar los recovery con la clave de datos ya autenticada, comprobando que el `vaultId` coincide. Mientras tanto, impedir el cambio de contraseña con recuperaciones pendientes. Hay que añadir una regresión con este escenario.

### GS04. Dos instancias sobre la misma bóveda privada pierden una escritura (P2)

Referencias: `electron/encrypted-vault.ts:143-144`. `electron/main.ts` no llama a `requestSingleInstanceLock`.

`checkDisk` y el renombrado son pasos separados, sin bloqueo entre procesos. Con dos instancias desbloqueadas que escriben a la vez, las dos responden «ok» y en disco solo queda una versión. La escritura perdida no genera recovery. Con el watcher activo, la instancia que pierde recibe después un CONFLICT, pero su escritura ya se había dado por guardada.

El intervalo entre comprobar y reemplazar está documentado en `README.md:124`. Lo nuevo es que la propia app puede provocarlo al abrir dos instancias, y que la escritura perdida se confirma sin dejar recuperación. Corrección: usar `app.requestSingleInstanceLock()` y, si se quiere tolerar otros procesos, un bloqueo por bóveda con detección de bloqueos obsoletos.

### CR01. El renombrado rompe wikilinks escapados en tablas (P2)

Referencias: `shared/linkUpdates.ts:32-37` y `electron/encrypted-vault.ts:338-339`.

`relink` divide el enlace por el primer `#` o `|` y vuelve a escribir solo la ruta. La `\` que escapa la barra dentro de una tabla, que es la forma habitual en Obsidian, se pierde. Por ejemplo, `| a | [[Nota\|alias]] |` pasa a ser `| a | [[/Otra|alias]] |` al renombrar `Nota.md` a `Otra.md`, y la celda se parte en dos. Ocurre en las bóvedas normales y en las privadas. Corrección: conservar la `\` anterior al separador y añadir una regresión.

### CR02. Los nombres con `#` producen enlaces erróneos (P2)

Referencias: `electron/storage.ts:183-189`, `src/editor/wikilinks.ts:9-18`, `src/editor/wikilinks.ts:114-119`, `src/editor/MarkdownEditor.tsx:54`, `src/editor/htmlWikiLinks.ts:132` y `shared/linkUpdates.ts:30`.

El almacenamiento acepta `#` en los nombres, pero todo destino generado se interpreta como `ruta#encabezado`. Elegir `C# básico` en el autocompletado inserta `[[/C# básico]]`, que resuelve a `C.md`, o a nada si `C.md` no existe. Renombrar `Nota.md` a `C# apuntes` reescribe los enlaces entrantes a un destino que no resuelve, así que el propio renombrado rompe enlaces que funcionaban. Corrección: rechazar en los nombres los caracteres que Obsidian prohíbe en enlaces (`# ^ [ ] |`), o no generar enlaces hacia esos destinos y avisar al usuario.

### GB01. La regex del usuario se ejecuta en el renderer sin límite de tiempo (P2)

Referencias: `src/components/SearchPanel.tsx:54-67`, `src/editor/HtmlEditor.tsx:178` y `shared/search.ts:237`.

El worker de búsqueda limita el tiempo de cada regex, pero hay dos rutas que vuelven a ejecutarla en el renderer:

- **Previsualización del reemplazo.** `replacementFor` trabaja sobre el texto de la previsualización, truncado a 160 caracteres. Con `'a'.repeat(180)+'b'` y `(a+)+b`, el worker encuentra la coincidencia en 0 ms, pero sobre el texto truncado la regex hace backtracking catastrófico y no termina.
- **Revelar un resultado en HTML.** Se ejecuta `matchAll` sobre el texto unido del bloque, que el worker no evaluó, con el mismo efecto.

La regex la escribe el propio usuario y no se guarda, así que reiniciar resuelve el cuelgue. Aun así, se salta la protección que existe justo para esto. Corrección: devolver desde el worker los reemplazos y posiciones ya calculados, sin volver a ejecutar la regex en el renderer.

### GB03. «Reemplazar todo» puede ir más allá de lo confirmado (P2)

Referencias: `src/components/SearchPanel.tsx:31`, `src/components/SearchPanel.tsx:182`, `src/components/SearchPanel.tsx:250-252` y `src/components/SearchPanel.tsx:281`.

El diálogo de confirmación guarda las entradas, pero `onConfirm` usa el `truncated` del resultado actual. Si con el diálogo abierto un cambio externo refresca la búsqueda y deja de estar truncada, un archivo del que solo se mostraban 10 coincidencias se envía sin rangos, y se reemplazan las 20. Requiere más de 10.000 coincidencias y un cambio externo durante la confirmación. Corrección: congelar en `Confirmation` los destinos exactos o el `truncated` del momento de la pregunta.

### CR03. Coste de resolver wikilinks por pulsación (P2)

Referencias: `src/editor/wikilinks.ts:77`, `src/editor/livePreview.ts:188`, `src/editor/livePreview.ts:202`, `src/editor/MarkdownEditor.tsx:180-185` y `src/App.tsx:333-337`.

`resolveWikiLink` ordena toda la lista de notas con `localeCompare` en cada llamada. La vista previa resuelve todos los enlaces en cada reconstrucción. Además, `notePaths` es un array nuevo en cada render, lo que fuerza un `reconfigure` extra por pulsación. Con 200 enlaces y 5.000 notas se midieron entre 61 y 420 ms por reconstrucción, según el orden de las rutas y el entorno. Las cifras son de Node, no de pulsaciones reales en Electron. Corrección: memorizar `notePaths` y usar un índice precalculado para la resolución. Conviene medir antes y después.

### GS02. Renombrar puede dejar una nota ilegible por tamaño (P3)

Referencias: `electron/storage.ts:214`, `electron/storage.ts:418` y `electron/storage.ts:718`.

La reescritura de enlaces al renombrar o mover no valida el tamaño con `plainBytes`. Una nota de exactamente 32 MiB que enlaza `[[a]]` pasa a 32 MiB + 2 bytes al renombrar `a.md`, y después `readNote` la rechaza. El archivo sigue íntegro y se puede abrir en otro editor. Las bóvedas privadas no se ven afectadas. Es el resto pendiente de F02.

### GS03. Si el reloj retrocede, la sesión privada dura más (P3)

Referencias: `electron/session-timer.ts:10`.

El temporizador calcula la expiración con `Date.now`. Con un retroceso de una hora, el bloqueo llega una hora tarde. Para retrasar el reloj hace falta acceso a la sesión de escritorio, y adelantarlo bloquea antes de tiempo, que es el caso seguro. Corrección: usar un reloj monotónico (`performance.now`) y bloquear al reanudar tras una suspensión.

### GB02. «Solo palabras completas» no respeta las palabras partidas entre nodos HTML (P3)

Referencias: `shared/search.ts:81` y `shared/search.ts:201`.

`<p>can<b>ción</b></p>` con «can» y la opción de palabra completa encuentra una coincidencia, y el reemplazo da `<p>X<b>ción</b></p>`. En Markdown ocurre lo mismo con `can**ción**`. La previsualización deja ver el problema antes de confirmar. Corrección: comprobar los límites con los caracteres visibles vecinos.

### GB04. Las notas omitidas por tiempo o memoria no se señalan (P3)

Referencias: `electron/search-runner.ts:24`, `electron/storage.ts:602`, `electron/encrypted-vault.ts:286` y `src/components/SearchPanel.tsx:334`.

Si el worker agota el tiempo o la memoria al analizar una nota, la nota se descarta y la interfaz muestra «Sin resultados» como si la búsqueda hubiera sido completa. El test `tests/search-vaults.test.ts:193-198` espera ese comportamiento. En la práctica solo afecta a notas HTML muy grandes. Corrección: devolver las notas omitidas e indicar que la búsqueda está incompleta.

### CR04. Un HTML sin `<body>` crece una línea en cada ciclo (P3)

Referencias: `src/editor/htmlDocument.ts:17-24`.

Si no hay `<body>` explícito, `joinHtmlDocument` añade un `\n` cada vez que se vuelve a separar y unir el documento: `<!-- c -->\n<p>a</p>` gana una línea en blanco por sesión de edición. Abrir la nota sin editar conserva los bytes (`src/editor/HtmlEditor.tsx:120-123`). Residual de F01.

### CR05. Un HTML con `<frameset>` pierde su cabecera al editar (P3)

Referencias: `src/editor/htmlDocument.ts:13-14` y `src/editor/htmlDocument.ts:23`.

Sin body, todo el archivo se trata como cuerpo. Al editar en la vista visual se pierden el doctype, el `<head>` y el `<frameset>`. `README.md:59-60` promete conservar el doctype y el head. Corrección: abrir esos documentos en modo código o en solo lectura.

### CR06. Deshacer puede revertir cambios externos (P3)

Referencias: `src/editor/HtmlEditor.tsx:139-150` y `src/editor/HtmlEditor.tsx:280-285`.

Al activar la vista HTML oculta, todos los cambios acumulados se aplican como un solo paso de deshacer, incluidos recargas externas, reemplazos globales y reescrituras de enlaces. Un Ctrl+Z revierte también el cambio externo, y el autoguardado lo persiste. Residual de F05. Corrección: aplicar las recargas en la vista oculta con `addToHistory=false` en cuanto llegan.

### CR07. La vista de código HTML no salta al encabezado enlazado (P3)

Referencias: `src/editor/HtmlEditor.tsx:157-167` y `src/editor/HtmlEditor.tsx:250-295`.

`HtmlSourceEditor` no gestiona `focusHeading`. Con la vista de código activa, `[[Pagina.html#Sección]]` abre la nota al principio, y el salto se aplica de forma invisible al editor visual oculto.

## Estado de la auditoría anterior

| ID | Estado | Evidencia |
| --- | --- | --- |
| F01 | Corregido | `src/editor/htmlDocument.ts:10-20` usa parse5 y sus offsets. Cubierto en `tests/html-notes.test.ts` y en E2E. Residuales: CR04 y CR05. |
| F02 | Parcial | El guardado directo, el cambio a privada y el reemplazo validan con `plainBytes` (`electron/storage.ts:435`, `:550` y `:628`). Falta el renombrado (GS02). |
| F03 | Corregido, con regresión | `electron/encrypted-vault.ts:200-227` deja `recoveryPending`. Tras cambiar la contraseña aparece GS01. No hay interfaz para resolver las recuperaciones aplazadas. |
| F04 | Corregido | `src/editor/wikilinks.ts:114-119` (`wikiTargetFor`). Residual: CR02. |
| F05 | Corregido | `src/editor/HtmlEditor.tsx:28-41` mantiene montadas las dos vistas. Residual: CR06. |
| F06 | Abierto | `index.html:2` permite `https:` pero no `http:`, mientras que `src/editor/livePreview.ts:24` admite `http:`. |
| F07 | Corregido | `src/components/EntryDialog.tsx:34-41`, cubierto en E2E. |
| F08 | Abierto | No se usa `aria-labelledby` ni `aria-label` en ningún diálogo. |
| F09 | Abierto | `sprintf-js@1.1.3` sigue llegando a través de `electron-builder@26.17.0`. El aviso no se volvió a consultar porque no se usó la red. |
| O01, O02 | Abiertos | Medidos en CR03. |
| O09 | Abierto | `electron/preload.ts:62` expone `privateActivity` y no se usa en `src/`. |
| O10 | Abierto | Confirmado con GS03 y GS04. |

**Actualización del 12 de octubre.** El commit `634e4a6` corrigió F02, F06, F08, F09 y O09, y la auditoría anterior quedó cerrada ([AUDITORIA-CERRADA.md](AUDITORIA-CERRADA.md)). Sus observaciones sin resolver se siguen aquí: O01 y O02 como CR03, O10 como GS03 y GS04, y el resto en la sección siguiente.

## Mejoras heredadas de la auditoría del 9 de octubre

No son fallos, sino propuestas que pasan a esta auditoría al cerrarse la anterior. Los detalles y las comprobaciones sugeridas están en [AUDITORIA-CERRADA.md](AUDITORIA-CERRADA.md#oportunidades-de-mejora).

| ID | Propuesta |
| --- | --- |
| O03 | Cargar el editor HTML bajo demanda: el bundle ocupa 1,49 MB (481 kB gzip) y Vite avisa del tamaño. |
| O04 | Extraer de `App.tsx` el guardado, los conflictos y la sesión privada. |
| O05 | Hacer que las E2E compilen lo que prueban: `test:e2e` no ejecuta el build antes. |
| O06 | Configurar CI, incluida la validación en Windows. |
| O07 | Mostrar la capacidad usada de la bóveda privada y permitir revisar las recuperaciones. Está relacionado con GS01. |
| O08 | Preparar una distribución verificable: firma, versión y hashes. |

## Evaluación de los resultados

**Fiabilidad de los hallazgos.** Los 15 hallazgos superaron la verificación del otro proveedor. Las líneas, los flujos y los escenarios citados eran correctos en todos los casos. GS04, que GPT entregó con confianza media y sin reproducir, se reprodujo sin dificultad y es de los más relevantes. Las reproducciones son en su mayoría en memoria o con servicios reales sobre bóvedas temporales. CR05, CR06, CR07 y GB03 no se recorrieron en la interfaz de Electron.

**Severidades.** Las dos verificaciones fueron asimétricas. Claude rebajó varias severidades de GPT: GB01 y GB03 de alta a media, y GS02 de media a baja. Para hacerlo valoró la probabilidad y si hay pérdida de datos. GPT mantuvo todas las de Claude y solo matizó cifras y alcances. Las prioridades de la tabla son la decisión del coordinador. Combinan impacto y probabilidad, y por eso GS01 sube a P1 aunque sea poco frecuente: bloquea el acceso y no hay forma evidente de recuperarlo.

**Complementariedad.** Los auditores GPT encontraron sobre todo fallos de estado y concurrencia en el proceso principal y en la búsqueda. El auditor Claude encontró fallos de formato y de interacción en el renderer. No hubo solapamientos. Cada verificador añadió matices útiles: la vía real de GS01, el CONFLICT tardío de GS04, la dependencia del entorno en el benchmark de CR03 y la conservación de bytes sin edición en CR04.

**Lo que no cubre.** No hubo evaluación criptográfica formal, sesión con lector de pantalla, benchmark en Electron con bóvedas grandes ni prueba del ejecutable empaquetado. Que las pruebas pasen no significa que no haya otros fallos.

## Orden de trabajo recomendado

1. ~~**GS01:** descifrar los recovery con la clave autenticada, con una regresión del escenario completo.~~ Hecho en `6eb02e3`.
2. ~~**GS04:** `requestSingleInstanceLock` en `main.ts`.~~ Hecho en `88ef450`, con el riesgo entre usuarios y equipos aceptado.
3. **CR01 y CR02:** conservar el escape en tablas y validar los caracteres de los nombres. Son baratos y protegen los enlaces de la bóveda.
4. **GB01 y GB03:** no volver a ejecutar la regex en el renderer y congelar los destinos confirmados.
5. **CR03 (con O01 y O02):** memorizar `notePaths` e indexar la resolución, midiendo antes y después.
6. **P3, F06, F08 y F09:** agruparlos según el área que se toque.

## Cierre

**Estado: abierta.**

Resueltos hasta ahora:

| ID | Resolución | Commit |
| --- | --- | --- |
| GS01 | Corregido. Las recuperaciones se descifran con la clave de datos que ya autenticó el contenedor principal, porque todas las copias selladas de una bóveda la comparten y el cambio de contraseña solo la reenvuelve. Una recuperación dañada se identifica por su nombre, y apartarla basta para desbloquear sin reabrir la app. Hay regresiones para el escenario completo (recuperación pendiente de 9 MiB y cambio de contraseña), para una recuperación anterior al cambio y para archivos alterados o truncados. Lo revisó GPT-6.1 Sol, que encontró dos limitaciones de diagnóstico (RV06 y RV07), ya corregidas. | `6eb02e3` |
| GS04 | Corregido para la propia aplicación y aceptado como riesgo entre usuarios o equipos. Black Cobble se ejecuta una sola vez por usuario del sistema: una segunda ejecución sale sin abrir la bóveda y muestra la ventana existente, que vuelve a crear si el proceso sigue vivo sin ventana, como en macOS. GPT-6.1 Sol encontró RV08 (macOS) y RV09 en la revisión. RV08 está corregido. RV09, que dos usuarios o equipos abran la misma bóveda a la vez (por ejemplo, en una carpeta sincronizada), lo aceptó el responsable del proyecto el 12 de octubre de 2026: un bloqueo en disco no sería fiable con carpetas sincronizadas. El riesgo queda documentado en README. Hay E2E de regresión en `tests/e2e/single-instance.spec.ts`. | `88ef450` |
| GS02 | Corregido junto con F02. Renombrar o mover valida cada reescritura con `plainBytes` antes de tocar el disco. | `634e4a6` |

Pendiente para cerrarla: resolver el resto de hallazgos GS, GB y CR y las mejoras heredadas (O03–O08). Cada uno se corrige con su commit, se descarta con motivo o se acepta como riesgo. Después se anota aquí la respuesta final, con fecha y quién la cierra, y se renombra este archivo a `AUDITORIA-2026-10-12-CERRADA.md`.
