# Black Cobble

Nombre provisional de la aplicación, versión alfa-0.1. La versión del paquete sigue siendo 0.1.1.

Editor de escritorio con Electron, React, CodeMirror 6 y TipTap. Cada nota es un archivo Markdown (`.md`) o HTML (`.html`) UTF-8 en una carpeta local; se elige el formato al crearla. La bóveda privada separada cifra también los títulos y las carpetas. Puedes abrir una bóveda existente o elegir una carpeta nueva.

## Ejecutar

Necesitas Node.js 22.12 o posterior.

```sh
npm ci
npm run dev
```

Para ejecutar una compilación de producción:

```sh
npm run build
npm start
```

Para empaquetar la aplicación hay un comando por sistema operativo:

```sh
npm run package         # sistema actual (Windows o Linux)
npm run package:win     # ejecutable portátil de Windows
npm run package:linux   # AppImage de Linux
```

- Windows: `release/Black Cobble 0.1.1.exe`. No requiere instalar Node.js en el equipo donde se use. El ejecutable no está firmado. También se puede generar desde Linux, sin Wine.
- Linux: `release/black-cobble-0.1.1-x86_64.AppImage`, un único archivo que no necesita instalación ni permisos de administrador. Hay que darle permiso de ejecución (`chmod +x`). Para arrancar necesita FUSE 2; si no lo hace, en Fedora instala `sudo dnf install fuse-libs`. Sin FUSE se puede ejecutar con `APPIMAGE_EXTRACT_AND_RUN=1` o extraer con `--appimage-extract`.
- Cada empaquetado deja además la carpeta sin empaquetar (`release/win-unpacked/` o `release/linux-unpacked/`), que usa la prueba de humo.

En Linux no hacen falta más requisitos de desarrollo que Node.js 22.12 o posterior.

## Uso

- Abre una carpeta como bóveda. `example-vault` contiene notas de prueba en ambos formatos.
- Selecciona una carpeta para crear notas o subcarpetas dentro de ella. Pulsa el nombre de la bóveda para seleccionar la raíz.
- El botón de tres puntos o el clic derecho sobre un archivo permite renombrar, mover o enviar a la papelera. La papelera es la del sistema operativo.
- El clic derecho sobre una carpeta ofrece «Nueva nota» y «Nueva carpeta», que crean dentro de ella, además de renombrar, mover o enviar a la papelera. En el espacio vacío del árbol o en el nombre de la bóveda, ofrece «Nueva nota» y «Nueva carpeta» en la raíz. El menú se cierra con Esc o al hacer clic fuera.
- Arrastra notas o carpetas sobre otra carpeta para moverlas. Para llevarlas a la raíz, suéltalas sobre el nombre de la bóveda o en el espacio vacío del árbol. El destino se resalta durante el arrastre. No se permite mover una carpeta dentro de sí misma ni sobrescribir archivos existentes.
- Escribe Markdown directamente. La línea activa muestra sus marcadores; las demás muestran el formato. Usa el botón `Vista en vivo` para cambiar a código fuente.
- Escribe `[[` para completar un enlace. Se admiten `[[Nota]]`, `[[Carpeta/Nota]]`, `[[Nota|Alias]]` y `[[Nota#Encabezado]]`. Haz clic para abrirlo, o Ctrl+clic si estás editando esa línea. Un destino inexistente ofrece crear la nota y sus carpetas.
- Fuera de la línea activa, los wikilinks muestran solo el nombre de la nota. Por ejemplo, `[[programacion/js]]` se ve como `js`. Si defines un alias, se muestra ese alias. Al editar la línea, reaparece la ruta completa; el archivo Markdown conserva siempre el enlace original.
- Los cambios se guardan tras una pausa de 450 ms. Ctrl+S guarda de inmediato y Ctrl+N crea una nota. Cambiar de nota o cerrar también guarda los cambios pendientes.
- Si otro programa modifica la nota, se recarga cuando no hay cambios locales. Si los hay, puedes guardar una copia o descartar y recargar. No se sobrescribe una versión que ya se sabe que ha cambiado.
- El botón del sol o la luna cambia de tema. La aplicación recuerda el tema, la última bóveda, la nota abierta y las carpetas expandidas.

## Notas HTML

Al crear una nota eliges **Markdown** (compatible con Obsidian, opción por defecto) o **HTML**. La aplicación recuerda la última elección. El formato no cambia después: renombrar conserva la extensión. Una carpeta no puede tener a la vez `Nota.md` y `Nota.html`, para que `[[Nota]]` nunca sea ambiguo.

- Las notas HTML se editan de forma visual, con barra de formato: encabezados, negrita, cursiva, tachado, código, listas, tareas, citas, bloques de código, separadores, tablas y alineación. También funcionan atajos como `# `, `**texto**`, `- ` o `[ ] `.
- Alinear a la izquierda, centrar o alinear a la derecha se aplica por bloque (párrafo o título, también dentro de listas, citas y tablas): al bloque donde está el cursor o a todos los bloques seleccionados. Botones de la barra o Ctrl+Shift+L / Ctrl+Shift+E / Ctrl+Shift+R (Cmd en macOS). Se guarda como `style="text-align: …"` en el HTML; alinear a la izquierda quita el estilo.
- `Vista en vivo` cambia al código HTML completo del archivo, incluida la cabecera. Cada vista conserva su historial: lo editado en la otra vista se deshace como un solo paso.
- Escribe `[[` para enlazar otra nota. En HTML el enlace se guarda como `<a class="wikilink" data-wikilink="Ruta">alias</a>`. Desde una nota Markdown, un enlace a una nota HTML conserva la extensión (`[[Pagina.html]]`) para que Obsidian también lo resuelva.
- El editor solo modifica el contenido de `<body>`; el doctype y `<head>` se conservan tal cual. Abrir una nota no la reescribe. Al editarla, el cuerpo se guarda con un bloque por línea y se descartan etiquetas, atributos y estilos no admitidos.
- El HTML de las notas se trata como contenido no confiable: nunca se ejecutan scripts ni manejadores de eventos, y no se cargan formularios ni marcos. Las imágenes siguen las mismas reglas que en Markdown.
- Obsidian no abre las notas HTML como notas: la compatibilidad con Obsidian se limita a las notas Markdown.

## Bóveda privada

El selector Normal / Privada separa dos bóvedas. La normal conserva archivos Markdown/HTML y carpetas reales. La privada guarda su árbol, títulos, contenido y borradores cifrados dentro de la carpeta oculta .black-cobble-private, siempre en la raíz de la normal. La normal no muestra ni permite modificar esa carpeta desde su árbol.

Selecciona Privada y pulsa Crear contraseña. Después usa Desbloquear bóveda para trabajar. Las notas nuevas de esa bóveda siempre son privadas; ya no hay un botón para cifrar notas individuales. Los archivos permanecen cifrados en disco mientras editas. Al bloquear, desaparecen el editor, los títulos, la búsqueda y el árbol privado. Sus rutas tampoco se guardan en las preferencias.

Cada bóveda resuelve sus propios wikilinks. No se pueden enlazar notas entre bóvedas. Mover o renombrar notas y carpetas desde Black Cobble actualiza los wikilinks que lo necesitan, conservando alias y encabezados. La normal se puede reorganizar mientras la privada está bloqueada. Los cambios hechos fuera de la aplicación no pueden recibir esa actualización garantizada.

La privada se bloquea manualmente, al volver a Normal, al cerrar, al abrir otra bóveda o después de 10 minutos sin actividad dentro de Black Cobble. Los guardados automáticos no reinician el plazo. Las imágenes externas en notas privadas requieren abrir su enlace expresamente.

Cambiar contraseña requiere la contraseña actual. No hay recuperación de contraseña. Respalda la carpeta .black-cobble-private completa, incluidos los archivos de recuperación si existen. El formato es un contenedor autenticado con AES-256-GCM y clave aleatoria protegida mediante scrypt. Desbloquear no exporta archivos descifrados.

Esta primera implementación admite **16 MiB en total** de notas, carpetas y borradores privados antes del cifrado. Al desbloquear, las versiones de los archivos de recuperación se incorporan como borradores mientras caben; las que no caben siguen cifradas en disco y se incorporan en un desbloqueo posterior, cuando haya espacio. Guarda una instantánea cifrada completa por operación. La existencia y el tamaño del contenedor son visibles. No protege una sesión desbloqueada frente a malware, ni elimina copias antiguas, el portapapeles o restos en la memoria del sistema. Cambiar la contraseña no invalida respaldos antiguos protegidos con la contraseña anterior.

La eliminación dentro de la bóveda privada es permanente y pide confirmación. No envía notas descifradas a la papelera del sistema. Las notas normales siguen usando la papelera del sistema.

Una nota puede ocupar hasta 32 MiB en disco; una nota cifrada, hasta 16 MiB de texto. Un guardado que supere el límite se rechaza y conserva el archivo anterior.

### Formato privado anterior

Las bóvedas de la versión experimental con cifrado por nota no se migran automáticamente. La aplicación conserva sus archivos y bloquea la configuración privada nueva si detecta el formato anterior. La compilación anterior (solo para Windows) se conserva en release/Black Cobble legacy private notes.exe para abrir esas notas. Mantén una copia completa antes de convertir o trasladar datos; no borres .black-cobble/private.json mientras existan notas o borradores que dependan de ella.

## Alcance del editor

Incluye encabezados, negrita, cursiva, tachado, citas, listas, tareas con casillas, código, separadores, enlaces Markdown, wikilinks e imágenes HTTP/HTTPS o datos de imagen. Las notas Markdown permanecen como texto Markdown y nunca se convierten a HTML; las notas HTML se guardan como HTML.

Las tablas tienen formato básico y conservan sus separadores. La carga de imágenes locales, los enlaces Markdown de referencia, embeds de notas, fórmulas, Mermaid y extensiones de Obsidian quedan pendientes. Los enlaces por nombre buscan primero en la carpeta actual; conviene usar rutas completas cuando hay nombres repetidos.

La aplicación muestra una bóveda y una nota cada vez. Omite carpetas ocultas, enlaces simbólicos y archivos o carpetas cuyo nombre no admite Windows (con `\ : * ? " < > |`), que Linux sí permite. Los nombres no distinguen mayúsculas en ningún sistema: no se puede crear, mover ni renombrar a `nota.md` si ya existe `Nota.md`, para que la bóveda siga siendo válida en Windows. Si una bóveda creada fuera de la aplicación en Linux tiene ambas, un wikilink prefiere la nota con las mismas mayúsculas. No modifica la configuración `.obsidian`. La configuración propia se guarda en los datos de la aplicación; el tema y el estado del árbol, en el almacenamiento local de Electron.

## Validación

```sh
npm test
npm run build
npm run test:e2e
```

Tras empaquetar, `npm run smoke:package` comprueba la apertura, la edición, el guardado, el cifrado en disco y el bloqueo del ejecutable sin empaquetar del sistema actual (`release/win-unpacked/Black Cobble.exe` o `release/linux-unpacked/black-cobble`) con una bóveda temporal. Otro ejecutable se indica con `BOVEDA_PACKAGED_EXE` o como argumento.

Las pruebas unitarias comprueban almacenamiento, rutas, conflictos, formato y resolución de wikilinks. Las pruebas de escritorio lanzan Electron con una bóveda temporal y verifican edición, tareas, navegación, CRUD, recuperación de conflictos, cambios externos y guardado al cerrar y reabrir. Las capturas se guardan en `test-results`.

`BOVEDA_TEST_VAULT` y `BOVEDA_USER_DATA` permiten aislar la bóveda y los datos de una ejecución de prueba. Deben ser rutas absolutas.

El cambio de nombre conserva el perfil de Bóveda, las claves de preferencias y las variables de prueba para mantener la configuración de la alfa.

## Código

- `electron/storage.ts`: acceso al disco, versiones SHA256, escritura mediante archivo temporal y renombrado, y vigilancia de cambios.
- `electron/encrypted-vault.ts`: árbol virtual, instantáneas cifradas y recuperación de la bóveda privada.
- `electron/vault-workspace.ts`: separación y selección de las dos bóvedas.
- `shared/notes.ts`: formatos de nota, extensiones y plantilla HTML.
- `shared/linkUpdates.ts`: actualización de wikilinks al mover o renombrar, en Markdown y en HTML.
- `electron/crypto.ts`: cifrado autenticado de notas y protección de la clave de bóveda con contraseña.
- `electron/session-timer.ts`: plazo de inactividad de la sesión privada.
- `electron/main.ts` y `electron/preload.ts`: ventana, selector de carpetas y puente IPC limitado. El renderer usa sandbox, aislamiento de contexto y no tiene acceso directo a Node.js.
- `src/App.tsx`: navegación, guardado, recuperación de conflictos y preferencias.
- `src/editor`: CodeMirror y decoraciones de Markdown, editor HTML con TipTap (`HtmlEditor.tsx`) y wikilinks.
- `shared/types.ts`: contrato entre Electron y la interfaz.
- `PLAN.md`: alcance y reparto del trabajo.

La comprobación de versión reduce los conflictos con otros programas, pero el sistema de archivos no ofrece una operación atómica de comparar versión y reemplazar. Existe un intervalo mínimo entre la última comprobación y el renombrado. No es un editor colaborativo.

Referencias: [aislamiento de contexto en Electron](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox) y [decoraciones de CodeMirror](https://codemirror.net/examples/decoration/).
