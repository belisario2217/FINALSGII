# Sistema de Gestión Escolar Académica

Aplicación web completa para administrar alumnos, catálogos académicos, grupos, docentes,
calificaciones, boletas, reportes, usuarios y analíticas.

## Stack

- React 19 + TypeScript + Vite
- Express 5 + TypeScript
- SQLite relacional mediante `node:sqlite`
- JWT, bcrypt y permisos configurables por rol
- XLSX/CSV para importación y exportación
- PDFKit para boletas y reportes imprimibles
- Vitest + Supertest

La arquitectura y el modelo de dominio están descritos en
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requisitos

- Node.js 22 o superior
- pnpm 10 o superior

## Instalación

```bash
pnpm install
```

Opcionalmente copia `.env.example` como `.env` y cambia `JWT_SECRET` antes de usar el
sistema fuera de un entorno local.

## Ejecución local

```bash
pnpm dev
```

- Interfaz: `http://localhost:4173`
- API: `http://localhost:4100`

Acceso inicial:

```text
Administrador: admin@aulanova.edu.mx / Admin123!
Alumno: alumno@campusfrontera.edu.mx / Alumno123!
```

Cambie esta contraseña al preparar una instalación real.

## Comandos

```bash
pnpm dev       # API y frontend con recarga automática
pnpm build     # validación TypeScript y build de producción
pnpm start     # inicia la API; sirve dist/ si NODE_ENV=production
pnpm test      # pruebas de flujos críticos
pnpm db:reset  # recrea la base local y carga datos de ejemplo
```

## Datos y migraciones

La base se crea en `data/school.db`. Las migraciones se aplican automáticamente desde
`server/migrations/` y los datos semilla se cargan únicamente cuando la base está vacía.

Los catálogos académicos son datos editables. Programas, turnos, grupos, ciclos, periodos,
materias, docentes, criterios, escalas y estatus no están fijados en la interfaz.

## Funcionalidad incluida

- Inicio de sesión, usuarios activos/inactivos, roles y permisos editables.
- CRUD y desactivación de todos los catálogos principales.
- Eliminación definitiva con confirmación para alumnos, materias, planes y registros sin dependencias.
- Borrado forzado opcional para eliminar también dependencias académicas relacionadas.
- Registro, búsqueda, filtros, baja y reactivación de alumnos.
- Importación de alumnos desde Excel/CSV con vista previa y errores por fila.
- Captura manual y ponderada de calificaciones.
- Captura de tres parciales con promedio y estatus calculados automáticamente.
- Planes académicos con asignaturas obligatorias u optativas, créditos y periodo sugerido.
- Edición completa de planes existentes, incluyendo su estructura de asignaturas.
- Portal del alumno con materias, parciales, promedio y avance curricular por créditos.
- Vinculación de cuentas con rol Alumno a una matrícula desde Usuarios.
- Importación de calificaciones con actualización o exclusión de existentes.
- Bloqueo de captura e historial de cada modificación.
- Exportación de alumnos y calificaciones a XLSX, CSV y PDF.
- Boletas individuales y masivas en PDF.
- Reportes de asistencia, concentrado, materias, docentes, reprobados y destacados.
- Analíticas por grupo, programa, turno, materia, periodo y docente.
- Logo, colores, datos institucionales, ciclo y escala configurables.
- Bitácora de actividad administrativa.

## Producción

```bash
pnpm build
set NODE_ENV=production
pnpm start
```

En producción use un secreto JWT robusto, HTTPS, copias de seguridad de `data/`, un
directorio de archivos con permisos restringidos y un proxy inverso. Para instalaciones
con alta concurrencia, la capa SQL puede migrarse a PostgreSQL conservando el modelo
relacional.
