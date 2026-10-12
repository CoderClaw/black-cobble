# Auditoría de Black Cobble

Fecha: 9 de octubre de 2026. Versión del paquete: 0.1.1.

Código revisado: commit `3cede7c710d2ffc86da15f07c986d0dfdb682202`. El árbol de trabajo estaba limpio al empezar. Esta auditoría añade documentación, sin corregir la aplicación ni actualizar dependencias.

## Resultado

La compilación y las 17 pruebas de escritorio pasan. Se han encontrado nueve problemas que las pruebas actuales no detectan o no cubren por completo. Cuatro tienen reproducción específica: corrupción de HTML al editar, notas que se guardan pero no vuelven a abrirse, recuperación privada que bloquea el desbloqueo y autocompletado que apunta a otra nota.

La primera corrección debería ser la conservación de HTML importado. Después conviene alinear los límites de almacenamiento y separar la recuperación privada del desbloqueo. La interfaz ya usa oscuro por defecto, permite cambiar a claro y mantiene una distribución sencilla; no necesita una remodelación visual para resolver estos problemas.

| ID | Prioridad | Problema | Evidencia |
| --- | --- | --- | --- |
| F01 | P1 | Editar HTML válido puede destruir parte de la cabecera | Reproducido con Electron |
| F02 | P2 | Una nota Unicode grande se guarda y después no puede abrirse | Reproducido con el servicio de almacenamiento |
| F03 | P2 | La recuperación privada puede impedir abrir un contenedor válido | Reproducido con dos servicios sobre la misma bóveda |
| F04 | P2 | Autocompletar una nota puede enlazar otra homónima | Reproducido con funciones de las fuentes |
| F05 | P2 | Cambiar de modo HTML destruye el historial de deshacer | Confirmado por el ciclo de vida del código |
| F06 | P2 | La política CSP bloquea imágenes HTTP que el editor admite | Incompatibilidad comprobada en código y configuración |
| F07 | P3 | El selector de formato cambia la selección sin mover el foco | Inspección del manejador de teclado |
| F08 | P3 | Los diálogos carecen de nombre accesible | Inspección del marcado |
| F09 | P3 | La cadena de empaquetado contiene una dependencia con aviso de seguridad | Registro npm y aviso público consultados |

P1 significa riesgo de corrupción que conviene resolver antes de distribuir otra versión. P2 cubre errores funcionales o de disponibilidad con condiciones concretas. P3 cubre accesibilidad y mantenimiento con menor urgencia en el alcance comprobado. La prioridad de F09 corresponde a esta aplicación; no sustituye la severidad moderada del aviso de seguridad.

## Alcance y método

Se coordinaron tres subagentes solicitados como GPT-6.1 Sol con razonamiento high:

| Revisión | Áreas |
| --- | --- |
| Seguridad y almacenamiento | Electron, IPC, rutas, cifrado, sesiones, guardado y recuperación |
| Edición y navegación | App, Markdown, HTML, wikilinks y código compartido |
| Experiencia de uso y calidad | Componentes, teclado, accesibilidad, rendimiento, pruebas y distribución |

La coordinación contrastó los hallazgos, eliminó duplicados, ejecutó la compilación y las suites existentes, consultó los avisos de dependencias y revisó la captura oscura generada por las pruebas. Las reproducciones utilizaron bóvedas temporales. No se utilizó Brave.

Las referencias `archivo:línea` corresponden al commit indicado y permiten localizar el código con el editor o `rg`. Los resultados completos de validación y sus límites están en [VERIFICACION-CERRADA.md](VERIFICACION-CERRADA.md).

## Problemas

### F01. Editar HTML puede destruir la cabecera

Prioridad P1. Reproducido en Electron.

Referencias: `src/editor/htmlDocument.ts:5-9`, `src/editor/HtmlEditor.tsx:77` y `src/editor/HtmlEditor.tsx:88-95`.

`splitHtmlDocument` busca la primera cadena que parece una etiqueta `<body>` mediante una expresión regular. También acepta una aparición dentro de un comentario del `<head>`. El editor visual interpreta el fragmento equivocado y el siguiente guardado reemplaza contenido que debía conservar.

Entrada válida utilizada:

```html
<!doctype html><html><head><!-- ejemplo <body> para documentación --><title>Mi título</title></head><body><p>Texto</p></body></html>
```

Después de añadir ` editado` en el editor visual, el archivo quedó así:

```html
<!doctype html><html><head><!-- ejemplo <body>
<p>para documentación --&gt;</p>
<p>Texto editado</p>
</body></html>
```

Desaparecen el título y el resto de la cabecera. Además, el comentario queda abierto y otro lector HTML puede ocultar el contenido. Esto incumple la conservación del `<head>` descrita en README.

Corrección propuesta: localizar el elemento body real con un parser que proporcione posiciones en el texto original. `parse5` ya es una dependencia. Utilizar esas posiciones para sustituir únicamente el cuerpo, conservando los bytes exteriores.

Criterio de cierre: editar el cuerpo de documentos con comentarios, cadenas de script y atributos que contienen texto similar a etiquetas no cambia ningún byte de su cabecera o cierre. La prueba debe comprobar el archivo guardado, además del texto visible.

### F02. El guardado acepta notas que la lectura rechaza

Prioridad P2. Reproducido con `VaultService`.

Referencias: `electron/main.ts:175-177`, `electron/storage.ts:191-200` y `electron/storage.ts:532-547`.

El IPC limita el contenido a 16.777.216 unidades de cadena JavaScript. La lectura limita el archivo a 32 MiB. La escritura convierte a UTF-8 sin comprobar que el resultado cabe en ese segundo límite.

La reproducción guardó `'漢'.repeat(12 * 1024 * 1024)`: 12.582.912 unidades UTF-16 admitidas por el IPC y 37.748.736 bytes en disco. `writeNote` terminó correctamente. La siguiente llamada a `readNote` respondió `La nota es demasiado grande para abrirse.`

El archivo conserva los datos, pero la aplicación deja de poder abrirlo. El usuario recibe un guardado correcto para un documento que ya no puede seguir editando en Black Cobble.

Corrección propuesta: definir un límite público en bytes UTF-8, comprobarlo antes de reemplazar el archivo y compartirlo con lectura e IPC. Mostrar el error conservando el contenido local.

Criterio de cierre: probar textos ASCII, CJK y emoji justo por debajo y por encima del límite. Todo guardado aceptado debe poder leerse después; un guardado rechazado debe conservar el archivo anterior.

### F03. La recuperación puede bloquear una bóveda privada válida

Prioridad P2. Reproducido con dos servicios de almacenamiento.

Referencias: `electron/encrypted-vault.ts:124-125`, `electron/encrypted-vault.ts:193-211` y `electron/encrypted-vault.ts:129-134`.

Al desbloquear, el servicio importa automáticamente las versiones divergentes de los archivos `recovery-*.sealed` como borradores. Después intenta cifrar todo dentro del contenedor de 16 MiB. Un contenedor principal válido y un archivo de recuperación válido pueden superar juntos ese límite.

Reproducción ejecutada sin fabricar archivos de recuperación:

1. El servicio A guarda una nota de 9 MiB de texto ASCII.
2. B abre la misma bóveda y sustituye el contenido por otros 9 MiB.
3. A intenta guardar un borrador, recibe `CONFLICT` y usa `retryPersistPrivateDrafts`.
4. El servicio conserva un archivo `recovery-*.sealed` y devuelve éxito en ese reintento.
5. Al reabrir, el desbloqueo importa la versión anterior como borrador y falla por superar 16 MiB.

Los datos cifrados siguen en disco. El problema es de disponibilidad y recuperación: la interfaz no permite entrar para decidir qué versión conservar. La precondición es un conflicto entre dos instancias o escritores, con contenido divergente suficientemente grande.

Corrección propuesta: permitir abrir el contenedor principal y revisar la recuperación por separado, sin incorporar todos los borradores de forma obligatoria. Conservar los archivos de recuperación hasta resolverlos expresamente.

Criterio de cierre: la reproducción anterior permite desbloquear y recuperar cada versión sin borrar archivos manualmente ni exceder silenciosamente el límite.

### F04. El autocompletado puede elegir el destino equivocado

Prioridad P2. Reproducido desde las funciones de las fuentes.

Referencias: `src/editor/MarkdownEditor.tsx:43-51`, `src/editor/htmlWikiLinks.ts:129-133`, `shared/notes.ts:31-33` y `src/editor/wikilinks.ts:89-91`.

Si existen `Nota.md`, `sub/Nota.md` y `sub/Origen.md`, elegir la sugerencia correspondiente a la nota raíz desde Origen genera `[[Nota]]`. Al resolver el enlace, la preferencia por una nota hermana abre `sub/Nota.md`.

La reproducción devolvió:

```json
{"selected":"Nota.md","generated":"Nota","resolved":"sub/Nota.md"}
```

El problema afecta a los autocompletados Markdown y HTML. La regla de resolver nombres hermanos está documentada; el fallo consiste en que una selección explícita del usuario genera un destino distinto.

Corrección propuesta: generar el destino con el contexto de la nota de origen y comprobar que resuelve al archivo seleccionado. `/Nota` desambigua este caso, como ya contempla `shared/linkUpdates.ts:29-30`.

Criterio de cierre: cada sugerencia, incluidas notas raíz, homónimas y HTML, resuelve exactamente al archivo que representa.

### F05. Cambiar de modo HTML elimina el historial

Prioridad P2. Hallazgo estático; no se ejecutó una reproducción específica del atajo.

Referencias: `src/editor/HtmlEditor.tsx:21-22`, `src/editor/HtmlEditor.tsx:65`, `src/editor/HtmlEditor.tsx:102-104` y `src/editor/HtmlEditor.tsx:181-197`.

La vista visual y la vista de código usan componentes distintos. Al cambiar entre ellas se destruye el editor anterior y se crea otro con un historial nuevo. Una edición previa deja de poder deshacerse después de alternar la presentación. También se reinician selección y posición.

Corrección propuesta: conservar el historial del documento durante el cambio de modo y definir cómo se comparten las operaciones entre TipTap y CodeMirror. No basta con conservar el último texto.

Criterio de cierre: editar HTML, pasar a código, volver a visual y deshacer restaura la versión anterior. Añadir también el recorrido inverso y verificar selección y posición cuando sea posible.

### F06. Las imágenes HTTP se admiten, pero la CSP las bloquea

Prioridad P2. Incompatibilidad estática comprobada; no se necesitó cargar una imagen externa.

Referencias: `src/editor/livePreview.ts:22-24`, `src/editor/livePreview.ts:33-34`, `src/editor/HtmlEditor.tsx:55-58` e `index.html:2`.

La validación acepta imágenes `http:` y `https:`, mientras que `img-src` solo permite `'self' data: https:`. En una nota normal, una imagen HTTP aceptada por el editor queda bloqueada por Chromium. README anuncia soporte para ambos protocolos.

Corrección propuesta: acordar una política única. Si se conserva la restricción a HTTPS, rechazar HTTP con un mensaje o enlace explícito y ajustar README. No ampliar la CSP solo para silenciar el fallo.

Criterio de cierre: Markdown y HTML muestran el mismo comportamiento documentado para HTTP, HTTPS, datos de imagen y fuentes rechazadas. Mantener el bloqueo automático de imágenes remotas en la bóveda privada.

### F07. El selector de formato separa foco y selección

Prioridad P3. Confirmado por inspección del manejador; sin prueba con lector de pantalla.

Referencia: `src/components/EntryDialog.tsx:33-36`.

Con el foco en Markdown, Flecha derecha selecciona HTML y cambia los `tabIndex`, pero el foco sigue en Markdown. Espacio activa ese botón y vuelve a elegir Markdown. El control conserva identidades React estables y no contiene ninguna llamada que enfoque la nueva opción.

Corrección propuesta: usar radios nativos con la apariencia actual, o mover el foco junto con el valor seleccionado.

Criterio de cierre: flechas, Espacio y Tab mantienen coordinados foco y selección, y crear la nota utiliza el formato anunciado por el control.

### F08. Los diálogos no tienen nombre accesible

Prioridad P3. Confirmado por inspección del marcado; sin sesión de lector de pantalla.

Referencias: `src/components/EntryDialog.tsx:25,31` y `src/components/PrivatePasswordDialog.tsx:13,21`.

Los títulos están en un `<h2>`, pero los elementos `<dialog>` no lo relacionan mediante `aria-labelledby` ni tienen `aria-label`. El diálogo no expone su título como nombre accesible, también al pedir una contraseña o confirmar una eliminación permanente.

Corrección propuesta: asociar el título con `aria-labelledby` y, cuando corresponda, la explicación con `aria-describedby`.

Criterio de cierre: comprobar el nombre accesible de cada diálogo y la entrada, recorrido y restitución del foco con teclado.

### F09. Hay un aviso de seguridad en las herramientas de empaquetado

Prioridad P3 en esta aplicación. Aviso de severidad moderada confirmado el día de la auditoría.

Referencias: `package.json:47`, `package-lock.json:3589`, `package-lock.json:4210`, `package-lock.json:5703` y `package-lock.json:5916`.

`npm audit --json` informa de ocho paquetes afectados dentro de una misma cadena transitiva. La dependencia de origen es `sprintf-js@1.1.3`, alcanzada desde `electron-builder@26.17.0`, `app-builder-lib`, `@electron/get`, `global-agent` y `roarr`. El aviso describe excepciones por especificadores de precisión sin límite cuando un atacante controla la cadena de formato. Fuente: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

Los ocho paquetes no representan ocho fallos independientes. `npm audit --omit=dev --json` devuelve cero avisos. No se demostró que una nota controle una cadena de formato de esa dependencia ni que el fallo sea explotable desde el editor.

Corrección propuesta: revisar la cadena de empaquetado y una versión compatible que elimine el aviso, verificando el resultado con un nuevo paquete. npm propone 26.5.0 para parte de la cadena, una versión anterior a la instalada; requiere evaluación y no justifica ejecutar `audit fix --force` automáticamente.

Criterio de cierre: documentar la resolución o la exposición aceptada, volver a consultar los avisos y comprobar el ejecutable generado. No se cambiaron versiones durante esta auditoría.

## Oportunidades de mejora

Estas propuestas no son fallos de rendimiento medidos ni compromisos de nuevas funciones.

| ID | Propuesta y evidencia | Beneficio y comprobación |
| --- | --- | --- |
| O01 | Memorizar las listas derivadas de `entries` en `src/App.tsx:318-322` y separar el estado de edición del árbol | Cada pulsación reconstruye `notePaths`, lo que vuelve a configurar CodeMirror en `src/editor/MarkdownEditor.tsx:145-150` y envía una transacción TipTap en `src/editor/HtmlEditor.tsx:117-120`. Medir la latencia con notas y bóvedas grandes antes y después. |
| O02 | Reducir el análisis completo del documento por pulsación | `src/App.tsx:668` analiza HTML para contar palabras; `src/editor/livePreview.ts:76-202` reconstruye decoraciones. Medir documentos largos y cambios de selección; aplicar actualización incremental o cálculo diferido donde aporte una mejora real. |
| O03 | Cargar el editor HTML cuando se necesite | La compilación emite un único JS de 1.303,27 kB, 427,45 kB gzip, con advertencia de tamaño. Evaluar importación dinámica y comparar tiempo de apertura y memoria. El tamaño por sí solo no demuestra lentitud. |
| O04 | Extraer guardado, conflictos y sesión privada de `App.tsx` | El componente concentra esos procesos, navegación, arrastre y diálogos en unas 700 líneas. Separar controladores o hooks con estados explícitos facilita probar carreras. Preservar las comprobaciones de sesión y generación existentes. |
| O05 | Hacer que las E2E compilen lo que prueban | `package.json:13` ejecuta Playwright directamente y las pruebas abren `dist-electron/main.cjs`. Añadir una preparación central o comando de validación que compile primero para evitar resultados sobre una compilación antigua. En esta auditoría sí se compiló antes. |
| O06 | Automatizar validación en Windows y ampliar pruebas de regresión | No se encontró configuración de CI versionada. Ejecutar compilación, unitarias y E2E, y añadir los escenarios F01-F08. Conservar trazas de fallos e investigar EPERM sin ocultarlo con reintentos globales indiscriminados. |
| O07 | Dar más control sobre capacidad y recuperación privada | El límite de 16 MiB incluye notas, árbol y borradores. Mostrar capacidad usada cerca del límite y permitir revisar archivos de recuperación por separado. Evitar paneles persistentes cuando no haya una acción pendiente. |
| O08 | Preparar una distribución verificable | El paquete Windows es portátil y no firmado según la configuración y README. Antes de ampliar su distribución, valorar firma, identificación de versión y hashes, y ejecutar el smoke test sobre cada artefacto recién generado. No se creó un paquete nuevo en esta revisión. |
| O09 | Reducir la API de actividad privada expuesta al renderer | `electron/preload.ts:60` expone `privateActivity`, aunque no hay llamadas en `src`. Mantener el envío desde los eventos confiables del preload reduce la capacidad de prolongar una sesión desde un renderer ya comprometido. No se encontró una vía para ejecutar código desde una nota. |
| O10 | Probar cambios de reloj y uso de la misma bóveda por varios procesos | `electron/session-timer.ts:9` usa `Date.now`, por lo que conviene probar retrocesos del reloj y suspensión. Valorar un bloqueo por bóveda si se quiere impedir escrituras simultáneas de varias instancias. Son medidas adicionales; el intervalo de conflicto de archivos ya está documentado. |

La búsqueda actual filtra nombres de archivos en `src/components/FileTree.tsx:27-30`. Una búsqueda de contenido sería una ampliación útil si las bóvedas crecen, pero no se considera un error del alcance actual. Backlinks, imágenes locales y otras funciones pendientes deben priorizarse después de los problemas de conservación y recuperación.

## Orden de trabajo recomendado

1. Corregir F01 con una regresión que compare bytes de cabecera y archivo final.
2. Resolver F02 y F03, incluidos límites, mensajes y recuperación sin manipulación manual de archivos.
3. Corregir F04 y definir la conservación de historial para F05.
4. Alinear imágenes, teclado y nombres accesibles en F06-F08. Revisar F09 junto con la siguiente actualización del empaquetado.
5. Automatizar la validación y medir O01-O03 antes de hacer optimizaciones amplias. Extraer responsabilidades de App por partes, sin mezclar esa refactorización con todas las correcciones anteriores.

## Protecciones existentes y límites de la revisión

La aplicación ya utiliza aislamiento de contexto, sandbox, Node deshabilitado en el renderer, comprobación de origen IPC y esquemas limitados para enlaces externos. El almacenamiento valida rutas, comprueba versiones antes de escribir y usa archivos temporales. La bóveda privada autentica el contenido cifrado y revoca sesiones. Las suites cubren varias carreras de cierre, bloqueo, conflictos y actualización de enlaces.

No se encontró una fuga de red en la prueba específica de `DOMParser` con una imagen remota: produjo cero solicitudes. No se incluye como vulnerabilidad. Esto no sustituye una prueba exhaustiva de todo HTML posible.

El borrado privado permanente, la ausencia de recuperación de contraseña, la compatibilidad limitada de HTML con Obsidian y el intervalo entre comprobar la versión y reemplazar el archivo están documentados. No se presentan como descubrimientos nuevos.

No se realizó una evaluación criptográfica formal, una sesión con lector de pantalla, un benchmark de bóvedas grandes ni una prueba del ejecutable portátil recién empaquetado. Tampoco se concluye que la aplicación esté libre de otros fallos por superar las pruebas existentes.

## Cierre

**Estado: cerrada** el 12 de octubre de 2026. La cierra Claude Opus 5.5, coordinador de la segunda auditoría, a petición del responsable del proyecto. Las correcciones finales las revisó GPT-6.1 Sol en tres turnos, y se resolvieron los cinco problemas que encontró (RV01–RV05).

### Hallazgos

| ID | Resolución | Commit |
| --- | --- | --- |
| F01 | Corregido. El cuerpo se localiza con parse5. Quedan dos residuales menores, CR04 y CR05, que sigue la auditoría del 12 de octubre. | `8fba6b5` |
| F02 | Corregido. Hay un único límite de 32 MiB en bytes para IPC, lectura y escritura. Renombrar o mover también valida cada reescritura de enlaces antes de tocar el disco, lo que resuelve GS02. Hay regresiones para ASCII, CJK y emoji en el límite y por encima de él, y para un rechazo que no cambia nada en disco. | `0e7abfc`, `634e4a6` |
| F03 | Corregido. Las recuperaciones que no caben quedan pendientes y ya no bloquean el desbloqueo. La auditoría del 12 de octubre encontró la regresión GS01 al cambiar la contraseña, que se sigue allí. | `0e7abfc` |
| F04 | Corregido. El autocompletado escribe un destino que resuelve a la nota elegida. El residual de los nombres con `#` es CR02. | `8fba6b5` |
| F05 | Corregido. Las dos vistas siguen montadas y conservan su historial. El residual de los cambios externos al deshacer es CR06. | `8fba6b5` |
| F06 | Corregido con una política única: se cargan imágenes HTTPS y datos raster en base64. HTTP y las fuentes no admitidas muestran un marcador accesible con el texto alternativo, igual en Markdown y en HTML. La CSP no se amplió. El bloqueo de imágenes remotas en la bóveda privada usa el protocolo normalizado, porque la revisión detectó que un espacio o un carácter de control inicial lo eludía. README y la especificación están actualizados. | `634e4a6` |
| F07 | Corregido. Las flechas mueven el foco junto con la selección. | `8fba6b5` |
| F08 | Corregido. Los tres diálogos (`EntryDialog`, `PrivatePasswordDialog` y la confirmación de «Reemplazar todo») tienen `aria-labelledby` y, cuando corresponde, `aria-describedby`. El hook `useModalDialog` devuelve el foco al control de origen, también en StrictMode y cuando el origen queda deshabilitado. El E2E `tests/e2e/dialog-accessibility.spec.ts` cubre nombre, descripción, foco inicial, Tab y Shift+Tab dentro del diálogo y restitución del foco. No hubo sesión con lector de pantalla. | `634e4a6` |
| F09 | Corregido. El override `global-agent@^4.1.3` elimina `roarr` y `sprintf-js@1.1.3`, y `npm audit` da 0 avisos el 12 de octubre de 2026. Se regeneró el AppImage de Linux y la prueba de humo del paquete pasa. El paquete de Windows no se regeneró. | `634e4a6` |

### Oportunidades de mejora

| ID | Resolución |
| --- | --- |
| O01, O02 | Medidas y trasladadas como CR03 a [AUDITORIA-2026-10-12.md](AUDITORIA-2026-10-12.md). |
| O03, O04, O05, O06, O07, O08 | Sin cambios. Pasan a la lista de mejoras heredadas de [AUDITORIA-2026-10-12.md](AUDITORIA-2026-10-12.md). |
| O09 | Hecho. El renderer ya no expone `privateActivity`, y la actividad llega solo desde los eventos confiables del preload (`634e4a6`). |
| O10 | Confirmado y trasladado como GS03 (reloj) y GS04 (varias instancias) a [AUDITORIA-2026-10-12.md](AUDITORIA-2026-10-12.md). |

### Verificación del cierre

Se ejecutó sobre el commit `634e4a6` en Linux (Fedora 44, Node.js 22.14.0). Typecheck sin errores. Vitest: 242 pruebas superadas y 3 omitidas. Build correcto. Playwright: 40 de 40 E2E superadas, incluidas las 13 nuevas de diálogos. `npm audit`: 0 avisos. `npm run package:linux` y `npm run smoke:package` correctos. Los dos E2E de regresión del foco fallan con la versión anterior del hook y pasan con la corregida.
