# Verificación de la auditoría

Fecha: 9 de octubre de 2026. Referencia del código: `3cede7c710d2ffc86da15f07c986d0dfdb682202`.

Este registro complementa [AUDITORIA-CERRADA.md](AUDITORIA-CERRADA.md). Distingue resultados de la aplicación, restricciones del entorno y pruebas específicas de los hallazgos.

## Entorno

| Elemento | Versión observada |
| --- | --- |
| Sistema | Windows, PowerShell |
| Node.js | 24.18.0 |
| npm | 11.16.0 |
| Electron | 42.11.10 |
| electron-builder | 26.17.0 |
| Vite | 6.4.4 |
| Vitest | 5.0.3 |
| Playwright | 1.63.0 |

Las versiones proceden del entorno instalado y de `npm ls`, no solo de los rangos declarados en `package.json`. Se utilizaron las dependencias ya instaladas; no se ejecutó `npm ci` ni una actualización.

## Comandos y resultados

| Comando | Resultado | Interpretación |
| --- | --- | --- |
| `git status --short` inicial | Sin cambios | Base limpia antes de añadir el informe |
| `npm run build` | Correcto | Incluye `tsc --noEmit`, Vite y compilación de Electron |
| `npm test`, dentro del sandbox | 11 suites sin poder cargar | `EPERM` al resolver rutas con `realpath`; no fueron fallos de aserciones |
| `npm test`, fuera del sandbox | 134 pruebas correctas, 1 fallida, 135 en total | La prueba de recuperación privada encontró `EPERM` al reemplazar `vault.sealed` |
| `npm test -- tests/encrypted-vault.test.ts`, fuera del sandbox | 19 de 19 correctas | La suite afectada pasó en el reintento; el primer fallo no se reprodujo |
| `npm run test:e2e`, dentro del sandbox | 17 fallos al iniciar Electron | No se llegó a validar los recorridos de interfaz |
| `npm run test:e2e`, fuera del sandbox | 17 de 17 correctas, 57,6 s | Se ejecutaron sobre la compilación generada en esta auditoría |
| `npm audit --json`, dentro del sandbox | Error DNS `ENOTFOUND` | No se pudo consultar el registro desde ese entorno |
| `npm audit --json`, fuera del sandbox | 8 avisos moderados, 0 altos, 0 críticos | Una cadena transitiva de herramientas de empaquetado |
| `npm audit --omit=dev --json` | 0 avisos | Sin avisos npm para el conjunto consultado de producción |

La ejecución completa de unitarias no terminó totalmente en verde. La evidencia exacta es 134/135 en la ejecución general y 19/19 al repetir la suite afectada. No se atribuye el primer `EPERM` a un antivirus ni a una causa concreta sin más evidencia. El código ya incluye reintentos limitados para `EPERM` y `EBUSY` en Windows en `electron/encrypted-vault.ts:136-146`.

La prueba afectada fue `keeps an encrypted recovery sidecar when another writer changes the snapshot`, en `tests/encrypted-vault.test.ts`. El error ocurrió en `EncryptedVault.replaceSnapshot`, al renombrar un archivo `.sealed-*.tmp` a `vault.sealed`.

La compilación generó:

```text
dist/index.html                    0.63 kB | gzip 0.39 kB
dist/assets/index-Dju-OA5F.css     15.76 kB | gzip 3.86 kB
dist/assets/index-DP3KwLuL.js    1303.27 kB | gzip 427.45 kB
```

Vite avisó de un fragmento JavaScript mayor de 500 kB. No falló la compilación ni se midió el coste de arranque.

## Recorridos cubiertos por las E2E

Las 17 pruebas abarcan edición Markdown y HTML, persistencia, tareas, navegación, creación y reorganización, conflictos externos, cierre y reapertura, arrastre, servidor de desarrollo bajo CSP, HTML no confiable, conservación del HTML sin editar, bóveda privada, cambio de contraseña, inactividad, carreras de guardado y limpieza de la interfaz al bloquear.

Que pasen estos recorridos no valida los casos adicionales de esta auditoría. Por ejemplo, la prueba existente de conservación HTML utiliza un documento que no contiene el falso `<body>` de F01.

Se revisó visualmente `test-results/desktop-dark.png`, generada por las pruebas. La captura muestra la navegación lateral, el editor y el estado de guardado con diseño sencillo y oscuro. Las capturas de `test-results` son artefactos locales ignorados por Git, no entregables permanentes de este informe.

## Reproducciones adicionales

| Hallazgo | Método | Resultado observado |
| --- | --- | --- |
| F01 | Separación desde fuentes y edición real en Electron con una bóveda temporal | El `<body>` dentro de un comentario se toma como cuerpo; editar destruye la cabecera. El informe conserva entrada y salida exactas. |
| F02 | Servicio `VaultService` compilado desde fuentes en memoria, con archivos temporales | Se guardan 37.748.736 bytes y la lectura posterior devuelve el error de tamaño. |
| F03 | Dos instancias del servicio sobre la misma bóveda temporal, conflicto y recuperación mediante sus métodos públicos | El reintento crea el archivo de recuperación. Reabrir falla porque la importación supera 16 MiB. |
| F04 | Generación y resolución de destinos desde las fuentes | La sugerencia raíz `Nota.md` genera `Nota` y resuelve a `sub/Nota.md`. |
| Hipótesis de carga de recursos en DOMParser | Electron, HTML con una imagen remota de prueba y observación de solicitudes | Cero solicitudes; hipótesis no incluida como vulnerabilidad. |

F05-F08 se fundamentan en el código y la configuración. No se ejecutaron pruebas específicas de historial entre modos, lector de pantalla o carga HTTP. El informe no los presenta como reproducciones dinámicas.

Los scripts auxiliares de los subagentes se retiraron. No se añadieron pruebas al producto, ni se alteraron notas del usuario.

## Avisos de dependencias

La cadena instalada observada fue:

```text
electron-builder@26.17.0
  app-builder-lib@26.17.0
    @electron/get@3.1.0
      global-agent@3.0.0
        roarr@2.15.4
          sprintf-js@1.1.3
```

El registro también propaga la afectación a `dmg-builder` y `electron-builder-squirrel-windows`. Por eso el total es ocho paquetes, aunque el aviso de origen consultado sea uno.

Se contrastó el aviso [GHSA-hp3w-g68c-fv3c, CVE-2026-97058](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), publicado el 24 de septiembre y actualizado el 5 de octubre de 2026. Afecta a `sprintf-js` hasta 1.1.3 y describe una denegación de servicio por precisiones numéricas no acotadas. La página consultada no indica una versión corregida del paquete.

No se ejecutó una explotación ni se estableció que las entradas del editor lleguen a esa función. El informe limita F09 a la cadena identificada y diferencia herramientas de desarrollo de dependencias de producción.

## Pendientes de validación

- Reproducir F05-F08 con pruebas de interfaz dedicadas al implementar las correcciones.
- Medir tiempos y memoria con documentos largos y bóvedas de distintos tamaños.
- Comprobar accesibilidad con lector de pantalla y navegación completa por teclado.
- Generar un paquete nuevo y ejecutar `node scripts/smoke-package.mjs` sobre ese artefacto.
- Investigar el fallo intermitente de renombrado si reaparece en Windows.

No se ejecutó `npm run package` ni el smoke test del ejecutable existente: hacerlo sobre un artefacto anterior no habría validado necesariamente el código auditado.

## Cierre

Cerrada el 12 de octubre de 2026 junto con [AUDITORIA-CERRADA.md](AUDITORIA-CERRADA.md), cuya sección de cierre recoge la resolución de cada hallazgo. Estado de los pendientes de validación anteriores:

- **F05–F08:** tienen pruebas de interfaz dedicadas en `tests/e2e/html-notes.spec.ts` y `tests/e2e/dialog-accessibility.spec.ts`.
- **Medición de rendimiento:** se hizo en Node y no en Electron (CR03 de la auditoría del 12 de octubre). La medición en Electron sigue pendiente allí.
- **Lector de pantalla:** sigue sin probarse. La navegación por teclado de los diálogos ya está cubierta por E2E.
- **Ejecutable empaquetado:** se generó un AppImage nuevo y pasó la prueba de humo. El ejecutable portátil de Windows no se regeneró.
- **Fallo de renombrado en Windows:** no reapareció. No se probó en Windows.
