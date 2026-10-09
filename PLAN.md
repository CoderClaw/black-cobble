# Plan del MVP

La bóveda privada independiente y la actualización de wikilinks al mover o renombrar están implementadas en `codex/encrypted-notes`. El diseño y los resultados de validación están en [ENCRYPTION_PLAN.md](ENCRYPTION_PLAN.md).

## Alcance

Aplicación de escritorio Electron con una bóveda abierta cada vez. Las notas son archivos UTF-8 `.md` y las carpetas son directorios reales. Interfaz en español, oscura por defecto, con tema claro.

- Abrir o crear una carpeta de bóveda y recordar la última.
- Árbol de carpetas y subcarpetas. Crear, renombrar, mover y enviar a la papelera notas o carpetas.
- Editor CodeMirror con Markdown en vivo en el propio documento y opción de código fuente. La sintaxis queda visible al editar una línea.
- Encabezados, énfasis, listas, tareas, citas, código, enlaces y separadores. Wikilinks con alias, rutas, autocompletado, navegación y creación de destinos inexistentes.
- Guardado automático con comprobación de versiones, escritura atómica y protección de cambios pendientes al navegar o cerrar.
- Actualizar el árbol ante cambios externos y avisar de conflictos antes de sobrescribir.

## Reparto

El agente principal define los contratos, prepara la compilación, integra, prueba la aplicación y documenta las limitaciones. Tres agentes GPT-6.1 Sol con razonamiento high implementan almacenamiento y Electron, editor Markdown, e interfaz y estado de la aplicación.

## Validación

1. TypeScript y compilación de producción.
2. Pruebas de archivos reales, rutas seguras, conflictos, carpetas y wikilinks.
3. Pruebas de la aplicación Electron con una bóveda temporal: edición, formato en vivo, navegación, guardado y reapertura.
4. Inspección visual de la interfaz y empaquetado para Windows.

## Fuera del MVP

Plugins de Obsidian, sincronización, graph view, canvas, compatibilidad completa con todos sus formatos extendidos, múltiples ventanas y edición colaborativa.

## Resultado

- Implementados los cuatro puntos del MVP y la interfaz de gestión de bóvedas.
- 48 pruebas unitarias aprobadas.
- 3 pruebas de escritorio aprobadas en Electron, incluidos conflictos, cierre temprano y modo de desarrollo.
- TypeScript y compilación de producción correctos.
- Temas oscuro y claro revisados mediante capturas de la aplicación real.
- Portátil Windows generado en `release/Boveda 0.1.0.exe`. Comprobadas apertura, edición y persistencia al cerrar en el ejecutable empaquetado de `release/win-unpacked`.
- Limitaciones de compatibilidad y funcionamiento documentadas en README.md.

## Referencias técnicas

- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.electronjs.org/docs/latest/tutorial/sandbox
- https://codemirror.net/examples/decoration/

## Actualización 0.1.1

- Arrastre de notas y carpetas hacia carpetas, subcarpetas y raíz. El destino se resalta y las carpetas cerradas se abren al mantener el arrastre encima.
- Los movimientos guardan primero la nota activa y actualizan su ruta cuando se mueve una carpeta que la contiene. Se rechazan destinos propios, descendientes y colisiones.
- Corrección para Windows: liberar los monitores de carpetas durante un movimiento o envío a papelera, y restablecerlos incluso si la operación falla.
- Los wikilinks muestran el nombre de la nota o su alias fuera de la línea activa. La ruta completa y el Markdown original se conservan.
- Validación: 70 pruebas unitarias y 5 pruebas de Electron aprobadas, incluidos arrastres nativos a subcarpetas y a los dos destinos de raíz, protección de contenido y enlaces abreviados.
