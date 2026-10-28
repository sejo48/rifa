# Lotería de Cloud

Versión compartida: https://rifa-cloud-sejo48.sejo48.chatgpt.site

Los sorteos A y B se guardan en Cloudflare D1. Cualquier visitante puede consultarlos; la página vuelve a consultar los datos cada cinco segundos y al recuperar conexión o regresar a la pestaña. Las escrituras requieren entrar con la clave compartida de administración. La clave se comprueba únicamente en el servidor y nunca se incluye en el HTML ni en este repositorio.

## Administración

1. Abre la versión compartida y selecciona **Acceso Admin**.
2. Escribe la clave de administración y pulsa **Entrar**. Puedes usar la misma clave desde otro dispositivo. Selecciona **Salir de Admin** al terminar.
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

`npm run build` crea `dist/server/index.js` con el HTML integrado, el manifiesto de hosting y las migraciones. El Worker requiere el binding D1 `DB`. Configura `ADMIN_PASSWORD_HASH` como secreto de Sites antes del despliegue. Su formato es `saltHex:hashHex`: sal aleatoria de 16 bytes y resultado de PBKDF2-HMAC-SHA256 con 100000 iteraciones y 32 bytes. No incluyas la clave ni su hash en GitHub, el HTML o el manifiesto de hosting.

Las sesiones duran 12 horas y usan cookies HttpOnly, Secure y SameSite=Strict. El servidor guarda únicamente el hash del token de sesión. Salir de Admin revoca la sesión de ese navegador; cambiar el secreto invalida todas las sesiones anteriores. Cinco intentos fallidos bloquean el acceso desde la misma IP durante 15 minutos. Las escrituras y el inicio/cierre de sesión comprueban el origen de la solicitud. El acceso de administración no utiliza cuentas de GitHub ni de ChatGPT.

El script de Tailwind usa el CDN original. Las pruebas automatizadas cubren acceso por clave, sesiones, limitación de intentos, persistencia, concurrencia, conflictos, borrados, importación y validación. La verificación visual del despliegue depende del acceso de red al dominio publicado.
