# Guía para compartir el proyecto

## Contenido

Este paquete contiene el código fuente del Sistema de Gestión Escolar de Universidad IFOP.
No incluye la base de datos local, archivos cargados, registros de ejecución, `node_modules`
ni variables privadas de entorno.

## Requisitos

- Node.js 22 o superior
- pnpm 10 o superior

## Ejecutar localmente

```bash
pnpm install
pnpm dev
```

Después abre `http://localhost:4173`.

## Validar el proyecto

```bash
pnpm build
pnpm test
```

## Seguridad

Antes de publicar una instalación real, configura un `JWT_SECRET` privado y cambia las
credenciales iniciales. No agregues archivos `.env` ni bases de datos al repositorio.
