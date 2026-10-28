# Lotería de Cloud

Versión compartida: https://rifa-cloud-sejo48.sejo48.chatgpt.site

Los sorteos A y B se guardan en Cloudflare D1. Cualquier visitante puede consultarlos; la página vuelve a consultar los datos cada cinco segundos y al recuperar conexión o regresar a la pestaña. Las escrituras requieren iniciar sesión con ChatGPT usando la cuenta administradora configurada en Sites. El servidor valida todos los permisos; no existe una contraseña en el navegador.

## Administración

1. Abre la versión compartida y selecciona **Acceso Admin con ChatGPT**.
2. Inicia sesión con la cuenta administradora.
3. Abre un número, escribe el comprador y selecciona apartado o pagado.
4. Espera la confirmación del servidor. Los cambios aparecen a los demás visitantes en un máximo habitual de cinco segundos mientras la página esté visible y tenga conexión.

Las ediciones del mismo número detectan conflictos y exigen revisar la versión actual antes de volver a guardar. Los cambios en números distintos se combinan sin perder ventas. Los borrados comprueban que el sorteo no haya cambiado desde la confirmación y afectan solo a esta aplicación.

## Pasar los datos de la versión anterior

La versión anterior guardaba ventas únicamente en el navegador de cada dispositivo. No es posible leer esos datos desde el nuevo dominio automáticamente.

Visita la página anterior, en el mismo navegador y dominio donde registraste las ventas. El `index.html` de este repositorio ofrece descargar un respaldo si detecta datos locales. Luego abre la versión compartida, accede como administrador y elige **Importar respaldo local**. Revisa el resumen y confirma. Solo se agregan números disponibles; las ventas ya registradas en la web no se reemplazan. Los datos locales originales se conservan.

Descarga respaldos desde el panel de administración antes de vaciar un sorteo.

## Código y comprobaciones

- `web/index.html`: interfaz conservando la presentación original.
- `worker/index.js`: API, autorización y persistencia mediante actualizaciones condicionales.
- `drizzle/0000_shared_lottery.sql`: esquema de la base de datos.
- `index.html`: entrada para GitHub Pages y exportación de datos locales anteriores.
- `.openai/hosting.json`: identidad del Site y binding D1.

Requiere Node.js 24 o superior para las pruebas con SQLite integrado. No hay dependencias de npm.

```sh
npm test
npm run build
```

`npm run build` crea `dist/server/index.js` con el HTML integrado, el manifiesto de hosting y las migraciones. El Worker requiere el binding D1 `DB`. Configura `ADMIN_EMAIL` en las variables protegidas de Sites antes del primer despliegue. En el primer acceso correcto, el servidor vincula al administrador por su ID estable de usuario del Site; cambiar únicamente el correo configurado no transfiere una cuenta ya vinculada.

La autenticación de producción depende de las cabeceras verificadas por Sites. No publiques este Worker detrás de un proxy que permita al visitante falsificar `oai-authenticated-user-id` u `oai-authenticated-user-email`. La página alojada en GitHub Pages redirige al Site porque GitHub Pages no ejecuta la API ni aloja una base de datos.

El script de Tailwind usa el CDN original. Las pruebas automatizadas cubren autorización, persistencia, concurrencia, conflictos, borrados, importación y validación; no sustituyen una prueba visual en navegador.
