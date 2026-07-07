# Arquitectura

## Decisiones técnicas

El sistema se implementa como un monolito modular TypeScript. La interfaz React y la API
Express se despliegan juntas, pero los dominios permanecen separados por rutas, servicios
y tablas. Este enfoque reduce la complejidad operativa para una escuela pequeña o mediana
y permite extraer módulos a servicios independientes si la carga futura lo requiere.

- **Frontend:** React + Vite, diseño responsivo y componentes reutilizables.
- **Backend:** Express con API REST, validación de entrada y autorización por permiso.
- **Persistencia:** SQLite mediante `node:sqlite`; el esquema SQL es compatible en concepto
  con PostgreSQL y está normalizado para facilitar una migración futura.
- **Autenticación:** contraseña con bcrypt, JWT de corta duración y control de cuenta activa.
- **Archivos:** XLSX/CSV para importación y exportación; PDFKit para documentos oficiales.
- **Auditoría:** historial específico de calificaciones y bitácora general de actividad.

## Estructura

```text
server/
  migrations/       Esquema relacional versionado
  db.ts              Conexión, migraciones y consultas
  auth.ts            JWT, permisos y middleware
  routes/            API por dominio
  services/          Importaciones, exportaciones y documentos
src/
  components/        Controles y layouts reutilizables
  pages/             Pantallas por módulo
  lib/               Cliente API y utilidades
docs/                 Arquitectura, instalación y uso
data/                 Base local creada en ejecución
uploads/              Archivos institucionales controlados
```

## Modelo de dominio

Un alumno conserva su identidad en `students`; su pertenencia a programa, turno, grupo y
ciclo se registra en `enrollments`. Las materias se vinculan a un grupo, docente y periodo
mediante `subject_assignments`. Los criterios y ponderaciones se copian a
`assignment_criteria`, evitando que un cambio futuro altere calificaciones históricas.

Los catálogos usan estado activo en lugar de depender de borrado físico. La interfaz no
contiene listas fijas de programas, turnos, grupos, periodos, escalas ni estatus.

## Seguridad

Cada ruta exige un permiso concreto. Los roles agrupan permisos editables y las cuentas
pueden desactivarse sin eliminar su historial. Las importaciones se procesan en memoria,
con límites de tamaño, validación previa y confirmación explícita. Toda modificación de
calificaciones guarda valor anterior, valor nuevo, usuario, fecha y motivo.
