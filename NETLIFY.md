# Publicar Universidad IFOP en Netlify

## Importar desde GitHub

1. Sube el contenido de este proyecto a un repositorio de GitHub.
2. En Netlify selecciona **Add new project > Import an existing project**.
3. Conecta el repositorio. Netlify detectara `netlify.toml` y ejecutara `pnpm build`.
4. Antes de publicar, agrega esta variable en **Project configuration > Environment variables**:

   `VITE_API_URL=https://URL-DE-TU-BACKEND/api`

5. En el servidor configura `APP_ORIGIN` con la URL final de Netlify, por ejemplo:

   `APP_ORIGIN=https://universidad-ifop.netlify.app`

## Importante

Netlify alojara la interfaz React. El servidor Express, la base SQLite y los archivos subidos requieren un servicio con almacenamiento persistente, por ejemplo Fly.io, Railway o Render. No publiques secretos, la base de datos ni el archivo `.env` en GitHub.
