import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
export const databasePath = path.resolve(projectRoot, process.env.DATABASE_PATH ?? "data/school.db");
export const restorePath = `${databasePath}.restore`;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

if (fs.existsSync(restorePath)) {
  if (fs.existsSync(databasePath)) {
    fs.copyFileSync(databasePath, `${databasePath}.before-restore`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
  }
  fs.renameSync(restorePath, databasePath);
}

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export function all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SqlValue[]) {
  return db.prepare(sql).run(...params);
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate() {
  const migrationsDir = path.join(here, "migrations");
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  for (const file of files) {
    const applied = get("SELECT id FROM schema_migrations WHERE name = ?", file);
    if (applied) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    transaction(() => {
      db.exec(sql);
      run("INSERT INTO schema_migrations(name) VALUES (?)", file);
    });
  }
}

const permissions = [
  ["dashboard.view", "Ver panel", "dashboard"],
  ["students.view", "Consultar alumnos", "students"],
  ["students.manage", "Administrar alumnos", "students"],
  ["students.import", "Importar alumnos", "students"],
  ["students.export", "Exportar alumnos", "students"],
  ["catalogs.view", "Consultar catálogos", "catalogs"],
  ["catalogs.manage", "Administrar catálogos", "catalogs"],
  ["grades.view", "Consultar calificaciones", "grades"],
  ["grades.manage", "Capturar calificaciones", "grades"],
  ["grades.import", "Importar calificaciones", "grades"],
  ["grades.export", "Exportar calificaciones", "grades"],
  ["grades.close", "Cerrar captura", "grades"],
  ["reports.view", "Consultar reportes", "reports"],
  ["reports.generate", "Generar documentos", "reports"],
  ["analytics.view", "Consultar analíticas", "analytics"],
  ["users.manage", "Administrar usuarios", "security"],
  ["roles.manage", "Administrar roles", "security"],
  ["settings.manage", "Configurar institución", "settings"],
  ["audit.view", "Consultar auditoría", "security"],
  ["portal.view", "Consultar portal del alumno", "student_portal"]
] as const;

export function seed() {
  if (get("SELECT id FROM roles LIMIT 1")) return;

  transaction(() => {
    const roleNames = [
      ["Administrador", "Control total del sistema", 1],
      ["Coordinador académico", "Planeación, calificaciones y analíticas", 1],
      ["Docente", "Consulta y captura de sus grupos", 1],
      ["Control escolar", "Alumnos, reportes y boletas", 1],
      ["Consulta", "Acceso de solo lectura", 1]
    ] as const;
    roleNames.forEach(([name, description, system]) =>
      run("INSERT INTO roles(name, description, is_system) VALUES (?, ?, ?)", name, description, system)
    );

    permissions.forEach(([code, name, module]) =>
      run("INSERT INTO permissions(code, name, module) VALUES (?, ?, ?)", code, name, module)
    );

    const adminRole = get<{ id: number }>("SELECT id FROM roles WHERE name = 'Administrador'")!;
    run(
      "INSERT INTO role_permissions(role_id, permission_id) SELECT ?, id FROM permissions",
      adminRole.id
    );

    const permissionSets: Record<string, string[]> = {
      "Coordinador académico": permissions.map(([code]) => code).filter((code) => !["users.manage", "roles.manage"].includes(code)),
      Docente: ["dashboard.view", "students.view", "grades.view", "grades.manage", "reports.view", "analytics.view"],
      "Control escolar": ["dashboard.view", "students.view", "students.manage", "students.import", "students.export", "catalogs.view", "grades.view", "grades.export", "reports.view", "reports.generate", "analytics.view"],
      Consulta: ["dashboard.view", "students.view", "catalogs.view", "grades.view", "reports.view", "analytics.view"]
    };
    Object.entries(permissionSets).forEach(([roleName, codes]) => {
      const role = get<{ id: number }>("SELECT id FROM roles WHERE name = ?", roleName)!;
      codes.forEach((code) => {
        const permission = get<{ id: number }>("SELECT id FROM permissions WHERE code = ?", code)!;
        run("INSERT INTO role_permissions(role_id, permission_id) VALUES (?, ?)", role.id, permission.id);
      });
    });

    const passwordHash = bcrypt.hashSync("Admin123!", 12);
    run(
      "INSERT INTO users(full_name, email, password_hash, role_id) VALUES (?, ?, ?, ?)",
      "Administrador General",
      "admin@aulanova.edu.mx",
      passwordHash,
      adminRole.id
    );

    run("INSERT INTO academic_levels(name, description) VALUES ('Bachillerato', 'Educación media superior')");
    const level = get<{ id: number }>("SELECT id FROM academic_levels LIMIT 1")!;
    run("INSERT INTO programs(code, name, level_id, duration_periods) VALUES ('BACH-GEN', 'Bachillerato General', ?, 6)", level.id);
    const program = get<{ id: number }>("SELECT id FROM programs LIMIT 1")!;

    run("INSERT INTO shifts(name, start_time, end_time) VALUES ('Matutino', '07:00', '14:00')");
    run("INSERT INTO shifts(name, start_time, end_time) VALUES ('Vespertino', '14:00', '20:00')");
    const morning = get<{ id: number }>("SELECT id FROM shifts WHERE name = 'Matutino'")!;

    run("INSERT INTO school_cycles(name, start_date, end_date) VALUES ('2026-2027', '2026-08-17', '2027-07-09')");
    const cycle = get<{ id: number }>("SELECT id FROM school_cycles LIMIT 1")!;
    run("INSERT INTO academic_periods(cycle_id, name, sequence, start_date, end_date) VALUES (?, 'Primer parcial', 1, '2026-08-17', '2026-10-16')", cycle.id);
    run("INSERT INTO academic_periods(cycle_id, name, sequence, start_date, end_date) VALUES (?, 'Segundo parcial', 2, '2026-10-19', '2026-12-18')", cycle.id);
    const period = get<{ id: number }>("SELECT id FROM academic_periods ORDER BY sequence LIMIT 1")!;

    run("INSERT INTO groups(name, program_id, shift_id, cycle_id, capacity) VALUES ('1A', ?, ?, ?, 32)", program.id, morning.id, cycle.id);
    run("INSERT INTO groups(name, program_id, shift_id, cycle_id, capacity) VALUES ('1B', ?, ?, ?, 32)", program.id, morning.id, cycle.id);
    const groupA = get<{ id: number }>("SELECT id FROM groups WHERE name = '1A'")!;

    run("INSERT INTO grading_scales(name, min_score, max_score, passing_score, decimals, is_default) VALUES ('Escala 0 a 10', 0, 10, 6, 1, 1)");
    const scale = get<{ id: number }>("SELECT id FROM grading_scales LIMIT 1")!;
    [["Activo", "#16866b", 0], ["Baja temporal", "#d97706", 0], ["Egresado", "#2563eb", 1], ["Baja definitiva", "#c2413b", 1]].forEach(([name, color, terminal]) =>
      run("INSERT INTO student_statuses(name, color, is_terminal) VALUES (?, ?, ?)", String(name), String(color), Number(terminal))
    );
    const activeStatus = get<{ id: number }>("SELECT id FROM student_statuses WHERE name = 'Activo'")!;

    [["MAT-101", "Matemáticas I", 5], ["COM-101", "Comunicación", 4], ["CIE-101", "Ciencias Experimentales", 5], ["HUM-101", "Humanidades", 3]].forEach(([code, name, hours]) =>
      run("INSERT INTO subjects(code, name, program_id, credits, hours_per_week) VALUES (?, ?, ?, ?, ?)", String(code), String(name), program.id, Number(hours), Number(hours))
    );

    run("INSERT INTO teachers(employee_number, full_name, email, specialty) VALUES ('DOC-001', 'Laura Méndez Ortega', 'laura.mendez@aulanova.edu.mx', 'Matemáticas')");
    run("INSERT INTO teachers(employee_number, full_name, email, specialty) VALUES ('DOC-002', 'Carlos Ruiz Salas', 'carlos.ruiz@aulanova.edu.mx', 'Comunicación')");
    const teacher = get<{ id: number }>("SELECT id FROM teachers WHERE employee_number = 'DOC-001'")!;

    [["Examen", 40], ["Tareas", 20], ["Proyecto", 25], ["Participación", 15]].forEach(([name, weight]) =>
      run("INSERT INTO evaluation_criteria(name, default_weight) VALUES (?, ?)", String(name), Number(weight))
    );

    const math = get<{ id: number }>("SELECT id FROM subjects WHERE code = 'MAT-101'")!;
    run("INSERT INTO subject_assignments(subject_id, group_id, teacher_id, period_id, grading_scale_id, evaluation_mode) VALUES (?, ?, ?, ?, ?, 'criteria')", math.id, groupA.id, teacher.id, period.id, scale.id);
    const assignment = get<{ id: number }>("SELECT id FROM subject_assignments LIMIT 1")!;
    all<{ id: number; default_weight: number }>("SELECT id, default_weight FROM evaluation_criteria").forEach((criterion) =>
      run("INSERT INTO assignment_criteria(assignment_id, criterion_id, weight) VALUES (?, ?, ?)", assignment.id, criterion.id, criterion.default_weight)
    );

    const sampleStudents = [
      ["AN26001", "Sofía", "Hernández", "Luna", "sofia.hernandez@example.com"],
      ["AN26002", "Diego", "Martínez", "Cruz", "diego.martinez@example.com"],
      ["AN26003", "Valentina", "García", "Reyes", "valentina.garcia@example.com"],
      ["AN26004", "Emiliano", "Sánchez", "Flores", "emiliano.sanchez@example.com"],
      ["AN26005", "Renata", "Torres", "Vega", "renata.torres@example.com"],
      ["AN26006", "Mateo", "Ramírez", "Díaz", "mateo.ramirez@example.com"]
    ];
    sampleStudents.forEach(([number, first, last, second, email], index) => {
      const student = run(
        "INSERT INTO students(student_number, first_name, last_name, second_last_name, email, status_id) VALUES (?, ?, ?, ?, ?, ?)",
        number, first, last, second, email, activeStatus.id
      );
      run(
        "INSERT INTO enrollments(student_id, program_id, shift_id, group_id, cycle_id, period_id) VALUES (?, ?, ?, ?, ?, ?)",
        Number(student.lastInsertRowid), program.id, morning.id, groupA.id, cycle.id, period.id
      );
      const enrollment = get<{ id: number }>("SELECT id FROM enrollments WHERE student_id = ?", Number(student.lastInsertRowid))!;
      const score = [9.4, 7.8, 8.7, 5.6, 9.0, 6.4][index];
      const grade = run(
        "INSERT INTO grades(enrollment_id, assignment_id, final_score, status, comments, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        enrollment.id, assignment.id, score, score >= 6 ? "passed" : "failed", index === 3 ? "Requiere asesoría" : "", 1, 1
      );
      all<{ id: number; weight: number }>(
        "SELECT id, weight FROM assignment_criteria WHERE assignment_id = ?",
        assignment.id
      ).forEach((criterion) => {
        run(
          "INSERT INTO grade_components(grade_id, assignment_criterion_id, score, weighted_score) VALUES (?, ?, ?, ?)",
          Number(grade.lastInsertRowid),
          criterion.id,
          score,
          score * criterion.weight / 100
        );
      });
    });

    run(
      "INSERT INTO institution_settings(id, institution_name, logo_path, address, phone, email, director_name, active_cycle_id, default_scale_id, footer_text) VALUES (1, 'Universidad IFOP', '/assets/campus-frontera.jpg', 'Av. del Aprendizaje 120, Ciudad de México', '55 5555 0142', 'contacto@aulanova.edu.mx', 'Dra. Mariana Castillo', ?, ?, 'Documento académico emitido por Universidad IFOP')",
      cycle.id,
      scale.id
    );
    run("INSERT INTO report_templates(name, type, header_text, footer_text, is_default) VALUES ('Boleta institucional', 'report_card', 'Universidad IFOP', 'Formando conocimiento con propósito', 1)");
  });
}

migrate();
seed();

function ensureEnhancementData() {
  transaction(() => {
    [
      ["Licenciatura", "Educación superior de nivel licenciatura"],
      ["Maestría", "Estudios de posgrado de nivel maestría"],
      ["Especialidad", "Programa de especialización profesional"]
    ].forEach(([name, description]) =>
      run("INSERT OR IGNORE INTO academic_levels(name, description) VALUES (?, ?)", name, description)
    );

    [
      ["LIC-GEN", "Licenciatura", "Licenciatura", 8],
      ["MAE-GEN", "Maestría", "Maestría", 4],
      ["ESP-GEN", "Especialidad", "Especialidad", 2]
    ].forEach(([code, name, levelName, duration]) => {
      const level = get<{ id: number }>("SELECT id FROM academic_levels WHERE name = ?", String(levelName));
      if (level) {
        run(
          "INSERT OR IGNORE INTO programs(code, name, level_id, duration_periods, description) VALUES (?, ?, ?, ?, ?)",
          String(code), String(name), level.id, Number(duration), `Programa base de ${name}`
        );
      }
    });

    run(
      "INSERT OR IGNORE INTO permissions(code, name, module) VALUES ('portal.view', 'Consultar portal del alumno', 'student_portal')"
    );
    run(
      "INSERT OR IGNORE INTO roles(name, description, is_system) VALUES ('Alumno', 'Acceso personal a materias, calificaciones y avance curricular', 1)"
    );
    run(
      `INSERT OR IGNORE INTO role_permissions(role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.name = 'Alumno' AND p.code = 'portal.view'`
    );
    run(
      `INSERT OR IGNORE INTO role_permissions(role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.name = 'Administrador' AND p.code = 'portal.view'`
    );

    run(
      `INSERT OR IGNORE INTO academic_plans(program_id, code, name, version, description)
       SELECT id, code || '-PLAN-2026', name || ' - Plan 2026', '2026',
              'Plan inicial generado a partir de las materias existentes'
       FROM programs
       WHERE EXISTS (SELECT 1 FROM subjects s WHERE s.program_id = programs.id)`
    );
    run(
      `INSERT OR IGNORE INTO plan_subjects(plan_id, subject_id, subject_type, credits, recommended_period)
       SELECT ap.id, s.id, 'mandatory', CASE WHEN s.credits > 0 THEN s.credits ELSE 1 END, 1
       FROM subjects s JOIN academic_plans ap ON ap.program_id = s.program_id`
    );
    run(
      `UPDATE enrollments SET plan_id = (
         SELECT ap.id FROM academic_plans ap
         WHERE ap.program_id = enrollments.program_id AND ap.is_active = 1
         ORDER BY ap.id DESC LIMIT 1
       ) WHERE plan_id IS NULL`
    );
    run(
      `UPDATE subject_assignments SET evaluation_mode = 'criteria'
       WHERE evaluation_mode = 'partials'
       AND EXISTS (SELECT 1 FROM assignment_criteria ac WHERE ac.assignment_id = subject_assignments.id)`
    );
    [
      ["payments.view", "Consultar cobros", "payments"],
      ["payments.manage", "Administrar cobros", "payments"],
      ["payments.export", "Exportar estados de cuenta", "payments"]
    ].forEach(([code, name, module]) =>
      run("INSERT OR IGNORE INTO permissions(code, name, module) VALUES (?, ?, ?)", code, name, module)
    );
    run(
      `INSERT OR IGNORE INTO role_permissions(role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.name IN ('Administrador', 'Coordinador acadÃ©mico')
       AND p.code IN ('payments.view', 'payments.manage', 'payments.export')`
    );

    const student = get<{ id: number; full_name: string }>(
      `SELECT id, TRIM(first_name || ' ' || last_name || ' ' || COALESCE(second_last_name, '')) AS full_name
       FROM students st
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.student_id = st.id)
       ORDER BY id LIMIT 1`
    );
    const role = get<{ id: number }>("SELECT id FROM roles WHERE name = 'Alumno'");
    const studentAccount = get(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'Alumno' LIMIT 1`
    );
    if (student && role && !studentAccount && !get("SELECT id FROM users WHERE email = 'alumno@campusfrontera.edu.mx'")) {
      run(
        "INSERT INTO users(full_name, email, password_hash, role_id, student_id) VALUES (?, ?, ?, ?, ?)",
        student.full_name,
        "alumno@campusfrontera.edu.mx",
        bcrypt.hashSync("Alumno123!", 12),
        role.id,
        student.id
      );
    }
  });
}

ensureEnhancementData();
