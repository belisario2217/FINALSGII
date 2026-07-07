import { Router } from "express";
import multer from "multer";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { createPdf, parseWorkbook, pdfTable, sendWorkbook, type TabularRow } from "../services/files.js";
import { ApiError, asId, cleanText, optionalText, sendCsv } from "../utils.js";

type StudentImportRow = {
  row: number;
  studentNumber: string;
  firstName: string;
  lastName: string;
  secondLastName: string;
  curp: string;
  email: string;
  phone: string;
  programId: number;
  shiftId: number;
  groupId: number;
  cycleId: number;
  periodId: number | null;
  statusId: number;
  exists: boolean;
};

type Preview = {
  createdAt: number;
  fileName: string;
  valid: StudentImportRow[];
  errors: Array<{ row: number; message: string }>;
};

const previews = new Map<string, Preview>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (allowed) callback(null, true);
    else callback(new ApiError(400, "Usa un archivo Excel o CSV."));
  }
});

export const studentsRouter = Router();

function normalizeKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function value(row: TabularRow, ...aliases: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, item]) => [normalizeKey(key), item]));
  for (const alias of aliases) {
    const found = normalized.get(normalizeKey(alias));
    if (found !== undefined) return cleanText(found, 250);
  }
  return "";
}

function studentSelect(where = "1 = 1") {
  return `SELECT st.id, st.student_number, st.first_name, st.last_name, st.second_last_name,
    TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS full_name,
    st.curp, st.birth_date, st.email, st.phone, st.emergency_contact, st.address, st.notes,
    st.is_active, ss.id AS status_id, ss.name AS status_name, ss.color AS status_color,
    e.id AS enrollment_id, e.program_id, p.name AS program_name, e.shift_id, sh.name AS shift_name,
    e.group_id, g.name AS group_name, e.cycle_id, sc.name AS cycle_name, e.period_id,
    ap.name AS period_name
    FROM students st
    JOIN student_statuses ss ON ss.id = st.status_id
    LEFT JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
    LEFT JOIN programs p ON p.id = e.program_id
    LEFT JOIN shifts sh ON sh.id = e.shift_id
    LEFT JOIN groups g ON g.id = e.group_id
    LEFT JOIN school_cycles sc ON sc.id = e.cycle_id
    LEFT JOIN academic_periods ap ON ap.id = e.period_id
    WHERE ${where}`;
}

studentsRouter.get("/", requirePermission("students.view"), (req, res) => {
  const search = cleanText(req.query.search, 100);
  const clauses = ["1 = 1"];
  const params: Array<string | number> = [];
  if (search) {
    clauses.push("(st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ? OR st.second_last_name LIKE ?)");
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  const filters: Array<[string, unknown]> = [
    ["e.program_id", req.query.programId],
    ["e.shift_id", req.query.shiftId],
    ["e.group_id", req.query.groupId],
    ["e.cycle_id", req.query.cycleId],
    ["st.status_id", req.query.statusId]
  ];
  filters.forEach(([column, filterValue]) => {
    if (filterValue) {
      clauses.push(`${column} = ?`);
      params.push(Number(filterValue));
    }
  });
  if (req.query.active === "true") clauses.push("st.is_active = 1");
  if (req.query.active === "false") clauses.push("st.is_active = 0");

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = clauses.join(" AND ");
  const total = get<{ count: number }>(
    `SELECT COUNT(DISTINCT st.id) AS count FROM students st
     LEFT JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1 WHERE ${where}`,
    ...params
  )?.count ?? 0;
  const records = all(
    `${studentSelect(where)} ORDER BY COALESCE(g.name, ''), COALESCE(sh.name, ''), st.last_name, st.first_name LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize
  );
  res.json({ records, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } });
});

studentsRouter.get("/record/:id", requirePermission("students.view"), (req, res) => {
  const record = get(`${studentSelect("st.id = ?")}`, asId(req.params.id, "Alumno"));
  if (!record) throw new ApiError(404, "No se encontró el alumno.");
  res.json(record);
});

studentsRouter.post("/", requirePermission("students.manage"), (req: AuthenticatedRequest, res) => {
  const body = req.body;
  const required = ["studentNumber", "firstName", "lastName", "statusId", "programId", "shiftId", "groupId", "cycleId"];
  if (required.some((field) => !body[field])) throw new ApiError(400, "Completa los datos obligatorios del alumno.");
  const id = transaction(() => {
    const student = run(
      `INSERT INTO students(student_number, first_name, last_name, second_last_name, curp, birth_date,
       email, phone, emergency_contact, address, notes, status_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cleanText(body.studentNumber, 40),
      cleanText(body.firstName, 100),
      cleanText(body.lastName, 100),
      optionalText(body.secondLastName, 100),
      optionalText(body.curp, 30),
      optionalText(body.birthDate, 20),
      optionalText(body.email, 180),
      optionalText(body.phone, 40),
      optionalText(body.emergencyContact, 180),
      optionalText(body.address, 300),
      optionalText(body.notes, 1000),
      asId(body.statusId, "Estatus")
    );
    const studentId = Number(student.lastInsertRowid);
    run(
      `INSERT INTO enrollments(student_id, program_id, shift_id, group_id, cycle_id, period_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      studentId,
      asId(body.programId, "Programa"),
      asId(body.shiftId, "Turno"),
      asId(body.groupId, "Grupo"),
      asId(body.cycleId, "Ciclo"),
      body.periodId ? asId(body.periodId, "Periodo") : null
    );
    return studentId;
  });
  logActivity(req, "create", "students", id, { studentNumber: body.studentNumber });
  res.status(201).json(get(`${studentSelect("st.id = ?")}`, id));
});

studentsRouter.patch("/:id", requirePermission("students.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Alumno");
  if (!get("SELECT id FROM students WHERE id = ?", id)) throw new ApiError(404, "No se encontró el alumno.");
  const body = req.body;
  transaction(() => {
    run(
      `UPDATE students SET student_number = COALESCE(?, student_number), first_name = COALESCE(?, first_name),
       last_name = COALESCE(?, last_name), second_last_name = ?, curp = ?, birth_date = ?, email = ?,
       phone = ?, emergency_contact = ?, address = ?, notes = ?, status_id = COALESCE(?, status_id),
       is_active = COALESCE(?, is_active), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      body.studentNumber ? cleanText(body.studentNumber, 40) : null,
      body.firstName ? cleanText(body.firstName, 100) : null,
      body.lastName ? cleanText(body.lastName, 100) : null,
      optionalText(body.secondLastName, 100),
      optionalText(body.curp, 30),
      optionalText(body.birthDate, 20),
      optionalText(body.email, 180),
      optionalText(body.phone, 40),
      optionalText(body.emergencyContact, 180),
      optionalText(body.address, 300),
      optionalText(body.notes, 1000),
      body.statusId ? asId(body.statusId, "Estatus") : null,
      body.isActive === undefined ? null : body.isActive ? 1 : 0,
      id
    );
    if (body.programId && body.shiftId && body.groupId && body.cycleId) {
      run("UPDATE enrollments SET is_active = 0 WHERE student_id = ? AND is_active = 1", id);
      run(
        `INSERT INTO enrollments(student_id, program_id, shift_id, group_id, cycle_id, period_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, cycle_id) DO UPDATE SET program_id = excluded.program_id,
         shift_id = excluded.shift_id, group_id = excluded.group_id, period_id = excluded.period_id, is_active = 1`,
        id, Number(body.programId), Number(body.shiftId), Number(body.groupId), Number(body.cycleId), body.periodId ? Number(body.periodId) : null
      );
    }
  });
  logActivity(req, "update", "students", id, body);
  res.json(get(`${studentSelect("st.id = ?")}`, id));
});

studentsRouter.post("/:id/toggle", requirePermission("students.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Alumno");
  run("UPDATE students SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  logActivity(req, "toggle-active", "students", id);
  res.json(get(`${studentSelect("st.id = ?")}`, id));
});

studentsRouter.delete("/:id/permanent", requirePermission("students.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Alumno");
  const student = get("SELECT id, student_number, first_name, last_name FROM students WHERE id = ?", id);
  if (!student) throw new ApiError(404, "El alumno ya no existe.");
  transaction(() => {
    run("UPDATE activity_logs SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE student_id = ?)", id);
    run("DELETE FROM users WHERE student_id = ?", id);
    run(
      `DELETE FROM grade_history WHERE grade_id IN (
         SELECT gr.id FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id WHERE e.student_id = ?
       )`,
      id
    );
    run(
      `DELETE FROM grade_components WHERE grade_id IN (
         SELECT gr.id FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id WHERE e.student_id = ?
       )`,
      id
    );
    run("DELETE FROM grades WHERE enrollment_id IN (SELECT id FROM enrollments WHERE student_id = ?)", id);
    run("DELETE FROM enrollments WHERE student_id = ?", id);
    run("DELETE FROM students WHERE id = ?", id);
  });
  logActivity(req, "permanent-delete", "students", id, student);
  res.status(204).end();
});

studentsRouter.get("/template/import.xlsx", requirePermission("students.import"), (_req, res) => {
  sendWorkbook(res, "plantilla-alumnos.xlsx", "Alumnos", [{
    "Matrícula": "AN26007",
    "Nombre(s)": "Andrea",
    "Apellido paterno": "López",
    "Apellido materno": "Morales",
    "CURP": "",
    "Correo": "andrea.lopez@example.com",
    "Teléfono": "",
    "Programa": "Bachillerato General",
    "Turno": "Matutino",
    "Grupo": "1A",
    "Ciclo": "2026-2027",
    "Periodo": "Primer parcial",
    "Estatus": "Activo"
  }]);
});

studentsRouter.post("/import/preview", requirePermission("students.import"), upload.single("file"), (req: AuthenticatedRequest, res) => {
  if (!req.file) throw new ApiError(400, "Selecciona un archivo.");
  const rows = parseWorkbook(req.file.buffer);
  if (!rows.length) throw new ApiError(400, "El archivo no contiene filas.");
  if (rows.length > 2000) throw new ApiError(400, "El archivo excede el límite de 2,000 filas.");

  const valid: StudentImportRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  rows.forEach((source, index) => {
    const rowNumber = index + 2;
    const studentNumber = value(source, "Matrícula", "Matricula", "student_number");
    const firstName = value(source, "Nombre(s)", "Nombre", "first_name");
    const lastName = value(source, "Apellido paterno", "last_name");
    const programName = value(source, "Programa", "Programa de estudios");
    const shiftName = value(source, "Turno");
    const groupName = value(source, "Grupo");
    const cycleName = value(source, "Ciclo", "Ciclo escolar");
    const statusName = value(source, "Estatus", "Estatus de alumno") || "Activo";
    const missing = [
      [studentNumber, "matrícula"], [firstName, "nombre"], [lastName, "apellido paterno"],
      [programName, "programa"], [shiftName, "turno"], [groupName, "grupo"], [cycleName, "ciclo"]
    ].filter(([item]) => !item).map(([, label]) => label);
    if (missing.length) {
      errors.push({ row: rowNumber, message: `Faltan: ${missing.join(", ")}.` });
      return;
    }
    const program = get<{ id: number }>("SELECT id FROM programs WHERE name = ? AND is_active = 1", programName);
    const shift = get<{ id: number }>("SELECT id FROM shifts WHERE name = ? AND is_active = 1", shiftName);
    const cycle = get<{ id: number }>("SELECT id FROM school_cycles WHERE name = ? AND is_active = 1", cycleName);
    const status = get<{ id: number }>("SELECT id FROM student_statuses WHERE name = ? AND is_active = 1", statusName);
    const group = program && shift && cycle
      ? get<{ id: number }>("SELECT id FROM groups WHERE name = ? AND program_id = ? AND shift_id = ? AND cycle_id = ? AND is_active = 1", groupName, program.id, shift.id, cycle.id)
      : undefined;
    const periodName = value(source, "Periodo", "Periodo escolar");
    const period = periodName && cycle
      ? get<{ id: number }>("SELECT id FROM academic_periods WHERE name = ? AND cycle_id = ? AND is_active = 1", periodName, cycle.id)
      : undefined;
    const invalid = [
      [program, `programa "${programName}"`], [shift, `turno "${shiftName}"`], [cycle, `ciclo "${cycleName}"`],
      [group, `grupo "${groupName}"`], [status, `estatus "${statusName}"`]
    ].filter(([item]) => !item).map(([, label]) => label);
    if (periodName && !period) invalid.push(`periodo "${periodName}"`);
    if (invalid.length) {
      errors.push({ row: rowNumber, message: `No existe o está inactivo: ${invalid.join(", ")}.` });
      return;
    }
    valid.push({
      row: rowNumber,
      studentNumber,
      firstName,
      lastName,
      secondLastName: value(source, "Apellido materno", "second_last_name"),
      curp: value(source, "CURP"),
      email: value(source, "Correo", "Email"),
      phone: value(source, "Teléfono", "Telefono"),
      programId: program!.id,
      shiftId: shift!.id,
      groupId: group!.id,
      cycleId: cycle!.id,
      periodId: period?.id ?? null,
      statusId: status!.id,
      exists: Boolean(get("SELECT id FROM students WHERE student_number = ?", studentNumber))
    });
  });
  const previewId = crypto.randomUUID();
  previews.set(previewId, { createdAt: Date.now(), fileName: req.file.originalname, valid, errors });
  logActivity(req, "preview-import", "students", previewId, { rows: rows.length, valid: valid.length, errors: errors.length });
  res.json({
    previewId,
    summary: { total: rows.length, valid: valid.length, errors: errors.length, existing: valid.filter((row) => row.exists).length },
    rows: valid.slice(0, 100),
    errors: errors.slice(0, 100)
  });
});

studentsRouter.post("/import/apply", requirePermission("students.import"), (req: AuthenticatedRequest, res) => {
  const preview = previews.get(String(req.body.previewId));
  if (!preview || Date.now() - preview.createdAt > 15 * 60 * 1000) throw new ApiError(400, "La vista previa expiró. Carga el archivo de nuevo.");
  const updateExisting = req.body.existingMode === "update";
  let created = 0;
  let updated = 0;
  let ignored = 0;
  transaction(() => {
    preview.valid.forEach((item) => {
      const existing = get<{ id: number }>("SELECT id FROM students WHERE student_number = ?", item.studentNumber);
      if (existing && !updateExisting) {
        ignored++;
        return;
      }
      let studentId = existing?.id;
      if (existing) {
        run(
          `UPDATE students SET first_name = ?, last_name = ?, second_last_name = ?, curp = COALESCE(?, curp),
           email = ?, phone = ?, status_id = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          item.firstName, item.lastName, optionalText(item.secondLastName), optionalText(item.curp), optionalText(item.email),
          optionalText(item.phone), item.statusId, existing.id
        );
        updated++;
      } else {
        const result = run(
          `INSERT INTO students(student_number, first_name, last_name, second_last_name, curp, email, phone, status_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          item.studentNumber, item.firstName, item.lastName, optionalText(item.secondLastName), optionalText(item.curp),
          optionalText(item.email), optionalText(item.phone), item.statusId
        );
        studentId = Number(result.lastInsertRowid);
        created++;
      }
      run(
        `INSERT INTO enrollments(student_id, program_id, shift_id, group_id, cycle_id, period_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, cycle_id) DO UPDATE SET program_id = excluded.program_id,
         shift_id = excluded.shift_id, group_id = excluded.group_id, period_id = excluded.period_id, is_active = 1`,
        studentId!, item.programId, item.shiftId, item.groupId, item.cycleId, item.periodId
      );
    });
  });
  previews.delete(String(req.body.previewId));
  logActivity(req, "apply-import", "students", String(req.body.previewId), { created, updated, ignored });
  res.json({ message: "Importación aplicada correctamente.", created, updated, ignored, errors: preview.errors.length });
});

studentsRouter.get("/export/file", requirePermission("students.export"), (req, res) => {
  const records = all<any>(`${studentSelect()} ORDER BY st.last_name, st.first_name`);
  const rows = records.map((student) => ({
    Matrícula: student.student_number,
    Alumno: student.full_name,
    Programa: student.program_name,
    Turno: student.shift_name,
    Grupo: student.group_name,
    Ciclo: student.cycle_name,
    Periodo: student.period_name,
    Estatus: student.status_name,
    Correo: student.email ?? "",
    Teléfono: student.phone ?? ""
  }));
  const format = String(req.query.format ?? "xlsx");
  if (format === "csv") {
    const headers = Object.keys(rows[0] ?? {});
    return sendCsv(res, "alumnos.csv", headers, rows.map((row) => headers.map((header) => row[header as keyof typeof row])));
  }
  if (format === "pdf") {
    const doc = createPdf(res, "alumnos.pdf", { layout: "landscape" });
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(18).text("Listado de alumnos");
    doc.moveDown(0.3).fillColor("#627d98").font("Helvetica").fontSize(9).text(`Generado: ${new Date().toLocaleString("es-MX")}`);
    doc.moveDown();
    pdfTable(doc, ["Matrícula", "Alumno", "Programa", "Turno", "Grupo", "Estatus"], rows.map((row) => [
      row.Matrícula, row.Alumno, row.Programa, row.Turno, row.Grupo, row.Estatus
    ]), [70, 170, 180, 70, 50, 90]);
    return doc.end();
  }
  return sendWorkbook(res, "alumnos.xlsx", "Alumnos", rows);
});
