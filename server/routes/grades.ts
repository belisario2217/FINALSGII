import { Router } from "express";
import multer from "multer";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { createPdf, parseWorkbook, pdfTable, sendWorkbook, type TabularRow } from "../services/files.js";
import { ApiError, asId, asNumber, cleanText, optionalText, sendCsv } from "../utils.js";

type GradeImportRow = {
  row: number;
  enrollmentId: number;
  assignmentId: number;
  studentNumber: string;
  studentName: string;
  subject: string;
  group: string;
  period: string;
  score: number;
  comments: string;
  existingGradeId: number | null;
};

type GradePreview = {
  createdAt: number;
  fileName: string;
  valid: GradeImportRow[];
  errors: Array<{ row: number; message: string }>;
};

const previews = new Map<string, GradePreview>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (allowed) callback(null, true);
    else callback(new ApiError(400, "Usa un archivo Excel o CSV."));
  }
});

export const gradesRouter = Router();

function normalizeKey(input: string) {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function value(row: TabularRow, ...aliases: string[]) {
  const values = new Map(Object.entries(row).map(([key, item]) => [normalizeKey(key), item]));
  for (const alias of aliases) {
    const found = values.get(normalizeKey(alias));
    if (found !== undefined) return cleanText(found, 500);
  }
  return "";
}

function assignmentSelect(where = "1 = 1") {
  return `SELECT a.id, a.subject_id, s.code AS subject_code, s.name AS subject_name,
    a.group_id, g.name AS group_name, p.id AS program_id, p.name AS program_name,
    sh.id AS shift_id, sh.name AS shift_name, a.teacher_id, t.full_name AS teacher_name,
    a.period_id, ap.name AS period_name, sc.name AS cycle_name, a.grading_scale_id,
    gs.name AS scale_name, gs.min_score, gs.max_score, gs.passing_score, gs.decimals,
    a.grade_entry_locked, a.evaluation_mode, a.is_active
    FROM subject_assignments a
    JOIN subjects s ON s.id = a.subject_id
    JOIN groups g ON g.id = a.group_id
    JOIN programs p ON p.id = g.program_id
    JOIN shifts sh ON sh.id = g.shift_id
    JOIN teachers t ON t.id = a.teacher_id
    JOIN academic_periods ap ON ap.id = a.period_id
    JOIN school_cycles sc ON sc.id = ap.cycle_id
    JOIN grading_scales gs ON gs.id = a.grading_scale_id
    WHERE ${where}`;
}

function saveGrade(
  userId: number,
  assignmentId: number,
  enrollmentId: number,
  score: number | null,
  comments: string | null,
  reason: string | null,
  components?: Record<string, unknown>,
  partials?: Record<string, unknown>
) {
  const assignment = get<{ min_score: number; max_score: number; passing_score: number; decimals: number; grade_entry_locked: number; evaluation_mode: string }>(
    `${assignmentSelect("a.id = ?")}`,
    assignmentId
  );
  if (!assignment) throw new ApiError(404, "No existe la asignación académica.");
  if (assignment.grade_entry_locked) throw new ApiError(409, "La captura de esta materia está cerrada.");
  if (score !== null && (score < assignment.min_score || score > assignment.max_score)) {
    throw new ApiError(400, `La calificación debe estar entre ${assignment.min_score} y ${assignment.max_score}.`);
  }
  const belongs = get(
    `SELECT e.id FROM enrollments e JOIN subject_assignments a ON a.group_id = e.group_id
     WHERE e.id = ? AND a.id = ? AND e.is_active = 1`,
    enrollmentId,
    assignmentId
  );
  if (!belongs) throw new ApiError(400, "El alumno no pertenece al grupo de la materia.");

  const current = get<{ id: number; final_score: number | null; comments: string | null; partial_1: number | null; partial_2: number | null; partial_3: number | null }>(
    "SELECT id, final_score, comments, partial_1, partial_2, partial_3 FROM grades WHERE enrollment_id = ? AND assignment_id = ?",
    enrollmentId,
    assignmentId
  );
  const assignmentCriteria = all<{ id: number; weight: number }>(
    "SELECT id, weight FROM assignment_criteria WHERE assignment_id = ? ORDER BY id",
    assignmentId
  );
  const componentValues: Array<{ id: number; score: number; weighted: number }> = [];
  let partialValues: Array<number | null> = [current?.partial_1 ?? null, current?.partial_2 ?? null, current?.partial_3 ?? null];
  let partialsComplete = false;
  if (partials && assignment.evaluation_mode === "partials") {
    partialValues = ["partial1", "partial2", "partial3"].map((key) => {
      const input = partials[key];
      if (input === "" || input === null || input === undefined) return null;
      const value = asNumber(input, "Calificación parcial");
      if (value < assignment.min_score || value > assignment.max_score) {
        throw new ApiError(400, `Cada parcial debe estar entre ${assignment.min_score} y ${assignment.max_score}.`);
      }
      return value;
    });
    const captured = partialValues.filter((value): value is number => value !== null);
    score = captured.length ? captured.reduce((sum, value) => sum + value, 0) / captured.length : null;
    partialsComplete = captured.length === 3;
  }
  if (!partials && components && assignmentCriteria.length) {
    for (const criterion of assignmentCriteria) {
      const input = components[String(criterion.id)];
      if (input === "" || input === null || input === undefined) continue;
      const componentScore = asNumber(input, "Calificación por criterio");
      if (componentScore < assignment.min_score || componentScore > assignment.max_score) {
        throw new ApiError(400, `Cada criterio debe estar entre ${assignment.min_score} y ${assignment.max_score}.`);
      }
      componentValues.push({
        id: criterion.id,
        score: componentScore,
        weighted: componentScore * criterion.weight / 100
      });
    }
    score = componentValues.length === assignmentCriteria.length
      ? componentValues.reduce((sum, component) => sum + component.weighted, 0)
      : null;
  }
  const rounded = score === null ? null : Number(score.toFixed(assignment.decimals));
  const status = rounded === null || (partials && !partialsComplete)
    ? "pending"
    : rounded >= assignment.passing_score ? "passed" : "failed";
  let gradeId: number;
  if (current) {
    run(
      `UPDATE grades SET final_score = ?, status = ?, comments = ?, partial_1 = ?, partial_2 = ?, partial_3 = ?, updated_by = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      rounded, status, comments, partialValues[0], partialValues[1], partialValues[2], userId, current.id
    );
    gradeId = current.id;
    if (current.final_score !== rounded || current.comments !== comments) {
      run(
        `INSERT INTO grade_history(grade_id, old_score, new_score, old_comments, new_comments, reason, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        gradeId, current.final_score, rounded, current.comments, comments, reason, userId
      );
    }
  } else {
    const inserted = run(
      `INSERT INTO grades(enrollment_id, assignment_id, final_score, status, comments,
       partial_1, partial_2, partial_3, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      enrollmentId, assignmentId, rounded, status, comments,
      partialValues[0], partialValues[1], partialValues[2], userId, userId
    );
    gradeId = Number(inserted.lastInsertRowid);
    run(
      `INSERT INTO grade_history(grade_id, old_score, new_score, old_comments, new_comments, reason, changed_by)
       VALUES (?, NULL, ?, NULL, ?, ?, ?)`,
      gradeId, rounded, comments, reason ?? "Captura inicial", userId
    );
  }
  if (components && assignmentCriteria.length) {
    run("DELETE FROM grade_components WHERE grade_id = ?", gradeId);
    componentValues.forEach((component) => {
      run(
        `INSERT INTO grade_components(grade_id, assignment_criterion_id, score, weighted_score)
         VALUES (?, ?, ?, ?)`,
        gradeId,
        component.id,
        component.score,
        component.weighted
      );
    });
  }
  return gradeId;
}

gradesRouter.get("/assignments", requirePermission("grades.view"), (req, res) => {
  const clauses = ["a.is_active = 1"];
  const params: number[] = [];
  [["a.group_id", req.query.groupId], ["a.teacher_id", req.query.teacherId], ["a.period_id", req.query.periodId]].forEach(([column, input]) => {
    if (input) {
      clauses.push(`${column} = ?`);
      params.push(Number(input));
    }
  });
  res.json(all(`${assignmentSelect(clauses.join(" AND "))} ORDER BY sc.start_date DESC, ap.sequence, g.name, s.name`, ...params));
});

gradesRouter.post("/assignments", requirePermission("catalogs.manage"), (req: AuthenticatedRequest, res) => {
  const body = req.body;
  const evaluationMode = ["partials", "criteria", "final"].includes(body.evaluationMode) ? body.evaluationMode : "partials";
  const criteria = evaluationMode === "criteria" && Array.isArray(body.criteria) ? body.criteria : [];
  const totalWeight = criteria.reduce((sum: number, item: { weight: unknown }) => sum + Number(item.weight || 0), 0);
  if (criteria.length && Math.abs(totalWeight - 100) > 0.01) throw new ApiError(400, "Las ponderaciones deben sumar 100%.");
  const id = transaction(() => {
    const result = run(
      `INSERT INTO subject_assignments(subject_id, group_id, teacher_id, period_id, grading_scale_id, evaluation_mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
      asId(body.subjectId, "Materia"),
      asId(body.groupId, "Grupo"),
      asId(body.teacherId, "Docente"),
      asId(body.periodId, "Periodo"),
      asId(body.gradingScaleId, "Escala"),
      evaluationMode
    );
    const assignmentId = Number(result.lastInsertRowid);
    criteria.forEach((item: { criterionId: unknown; weight: unknown }) => {
      run(
        "INSERT INTO assignment_criteria(assignment_id, criterion_id, weight) VALUES (?, ?, ?)",
        assignmentId,
        asId(item.criterionId, "Criterio"),
        asNumber(item.weight, "Ponderación")
      );
    });
    return assignmentId;
  });
  logActivity(req, "create", "subject_assignments", id, body);
  res.status(201).json(get(`${assignmentSelect("a.id = ?")}`, id));
});

gradesRouter.get("/assignment/:id/roster", requirePermission("grades.view"), (req, res) => {
  const assignmentId = asId(req.params.id, "Asignación");
  const assignment = get(`${assignmentSelect("a.id = ?")}`, assignmentId);
  if (!assignment) throw new ApiError(404, "No se encontró la materia asignada.");
  const criteria = all(
    `SELECT ac.id, ac.criterion_id, ec.name, ac.weight
     FROM assignment_criteria ac JOIN evaluation_criteria ec ON ec.id = ac.criterion_id
     WHERE ac.assignment_id = ? ORDER BY ac.id`,
    assignmentId
  );
  const students = all<any>(
    `SELECT e.id AS enrollment_id, st.id AS student_id, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
     gr.id AS grade_id, gr.final_score, gr.partial_1, gr.partial_2, gr.partial_3,
     gr.status, gr.comments, gr.updated_at
     FROM enrollments e JOIN students st ON st.id = e.student_id
     JOIN subject_assignments a ON a.group_id = e.group_id
     LEFT JOIN grades gr ON gr.enrollment_id = e.id AND gr.assignment_id = a.id
     WHERE a.id = ? AND e.is_active = 1 AND st.is_active = 1
     ORDER BY st.last_name, st.first_name`,
    assignmentId
  );
  const components = all<{ enrollment_id: number; assignment_criterion_id: number; score: number }>(
    `SELECT gr.enrollment_id, gc.assignment_criterion_id, gc.score
     FROM grade_components gc JOIN grades gr ON gr.id = gc.grade_id
     WHERE gr.assignment_id = ?`,
    assignmentId
  );
  const componentsByEnrollment = components.reduce<Record<number, Record<string, number>>>((grouped, component) => {
    (grouped[component.enrollment_id] ??= {})[String(component.assignment_criterion_id)] = component.score;
    return grouped;
  }, {});
  res.json({
    assignment,
    criteria,
    students: students.map((student) => ({ ...student, components: componentsByEnrollment[student.enrollment_id] ?? {} }))
  });
});

gradesRouter.put("/assignment/:id", requirePermission("grades.manage"), (req: AuthenticatedRequest, res) => {
  const assignmentId = asId(req.params.id, "Asignación");
  const rows = Array.isArray(req.body.grades) ? req.body.grades : [];
  if (!rows.length) throw new ApiError(400, "No hay calificaciones para guardar.");
  transaction(() => {
    rows.forEach((item: any) => {
      const rawScore = item.score;
      const score = rawScore === "" || rawScore == null ? null : asNumber(rawScore, "Calificación");
      saveGrade(
        req.user!.id,
        assignmentId,
        asId(item.enrollmentId, "Inscripción"),
        score,
        optionalText(item.comments, 1000),
        optionalText(item.reason, 300) ?? "Captura manual",
        item.components && typeof item.components === "object" ? item.components : undefined,
        item.partials && typeof item.partials === "object" ? item.partials : undefined
      );
    });
  });
  logActivity(req, "save-grades", "subject_assignments", assignmentId, { count: rows.length });
  res.json({ message: "Calificaciones guardadas.", count: rows.length });
});

gradesRouter.post("/assignment/:id/toggle-lock", requirePermission("grades.close"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Asignación");
  run(
    `UPDATE subject_assignments SET grade_entry_locked = CASE grade_entry_locked WHEN 1 THEN 0 ELSE 1 END,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    id
  );
  const record = get(`${assignmentSelect("a.id = ?")}`, id);
  logActivity(req, "toggle-grade-lock", "subject_assignments", id, record);
  res.json(record);
});

gradesRouter.get("/history/:gradeId", requirePermission("grades.view"), (req, res) => {
  res.json(all(
    `SELECT h.*, u.full_name AS changed_by_name FROM grade_history h
     JOIN users u ON u.id = h.changed_by WHERE h.grade_id = ? ORDER BY h.changed_at DESC`,
    asId(req.params.gradeId, "Calificación")
  ));
});

gradesRouter.get("/template/import.xlsx", requirePermission("grades.import"), (_req, res) => {
  sendWorkbook(res, "plantilla-calificaciones.xlsx", "Calificaciones", [{
    "Matrícula": "AN26001",
    "Nombre del alumno": "Sofía Hernández Luna",
    "Programa de estudios": "Bachillerato General",
    "Turno": "Matutino",
    "Grupo": "1A",
    "Materia": "MAT-101",
    "Periodo": "Primer parcial",
    "Calificación": 9.5,
    "Observaciones": ""
  }]);
});

gradesRouter.post("/import/preview", requirePermission("grades.import"), upload.single("file"), (req: AuthenticatedRequest, res) => {
  if (!req.file) throw new ApiError(400, "Selecciona un archivo.");
  const rows = parseWorkbook(req.file.buffer);
  if (!rows.length) throw new ApiError(400, "El archivo no contiene filas.");
  if (rows.length > 3000) throw new ApiError(400, "El archivo excede el límite de 3,000 filas.");
  const valid: GradeImportRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  rows.forEach((source, index) => {
    const rowNumber = index + 2;
    const studentNumber = value(source, "Matrícula", "Matricula");
    const programName = value(source, "Programa de estudios", "Programa");
    const shiftName = value(source, "Turno");
    const groupName = value(source, "Grupo");
    const subjectInput = value(source, "Materia");
    const periodName = value(source, "Periodo");
    const scoreInput = value(source, "Calificación", "Calificacion");
    if (!studentNumber || !programName || !shiftName || !groupName || !subjectInput || !periodName || scoreInput === "") {
      errors.push({ row: rowNumber, message: "Faltan uno o más campos obligatorios." });
      return;
    }
    const score = Number(scoreInput);
    if (!Number.isFinite(score)) {
      errors.push({ row: rowNumber, message: "La calificación no es numérica." });
      return;
    }
    const match = get<{
      enrollment_id: number;
      student_name: string;
      assignment_id: number;
      subject_name: string;
      min_score: number;
      max_score: number;
      grade_entry_locked: number;
    }>(
      `SELECT e.id AS enrollment_id,
       TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
       a.id AS assignment_id, s.name AS subject_name, gs.min_score, gs.max_score, a.grade_entry_locked
       FROM students st JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
       JOIN programs p ON p.id = e.program_id JOIN shifts sh ON sh.id = e.shift_id
       JOIN groups g ON g.id = e.group_id JOIN subject_assignments a ON a.group_id = g.id
       JOIN subjects s ON s.id = a.subject_id JOIN academic_periods ap ON ap.id = a.period_id
       JOIN grading_scales gs ON gs.id = a.grading_scale_id
       WHERE st.student_number = ? AND p.name = ? AND sh.name = ? AND g.name = ?
       AND (s.code = ? OR s.name = ?) AND ap.name = ?`,
      studentNumber, programName, shiftName, groupName, subjectInput, subjectInput, periodName
    );
    if (!match) {
      errors.push({ row: rowNumber, message: "No coincide el alumno, programa, turno, grupo, materia o periodo." });
      return;
    }
    if (match.grade_entry_locked) {
      errors.push({ row: rowNumber, message: "La captura de esta materia está cerrada." });
      return;
    }
    if (score < match.min_score || score > match.max_score) {
      errors.push({ row: rowNumber, message: `La calificación debe estar entre ${match.min_score} y ${match.max_score}.` });
      return;
    }
    const existing = get<{ id: number }>(
      "SELECT id FROM grades WHERE enrollment_id = ? AND assignment_id = ?",
      match.enrollment_id,
      match.assignment_id
    );
    valid.push({
      row: rowNumber,
      enrollmentId: match.enrollment_id,
      assignmentId: match.assignment_id,
      studentNumber,
      studentName: match.student_name,
      subject: match.subject_name,
      group: groupName,
      period: periodName,
      score,
      comments: value(source, "Observaciones", "Comentarios"),
      existingGradeId: existing?.id ?? null
    });
  });
  const previewId = crypto.randomUUID();
  previews.set(previewId, { createdAt: Date.now(), fileName: req.file.originalname, valid, errors });
  run(
    `INSERT INTO grade_imports(file_name, file_type, total_rows, valid_rows, error_rows, status, errors_json, imported_by)
     VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?)`,
    req.file.originalname,
    req.file.mimetype,
    rows.length,
    valid.length,
    errors.length,
    JSON.stringify(errors),
    req.user!.id
  );
  logActivity(req, "preview-import", "grades", previewId, { total: rows.length, valid: valid.length, errors: errors.length });
  res.json({
    previewId,
    summary: { total: rows.length, valid: valid.length, errors: errors.length, existing: valid.filter((row) => row.existingGradeId).length },
    rows: valid.slice(0, 150),
    errors: errors.slice(0, 150)
  });
});

gradesRouter.post("/import/apply", requirePermission("grades.import"), (req: AuthenticatedRequest, res) => {
  const previewId = String(req.body.previewId ?? "");
  const preview = previews.get(previewId);
  if (!preview || Date.now() - preview.createdAt > 15 * 60 * 1000) throw new ApiError(400, "La vista previa expiró. Carga el archivo de nuevo.");
  const updateExisting = req.body.existingMode === "update";
  let created = 0;
  let updated = 0;
  let ignored = 0;
  transaction(() => {
    preview.valid.forEach((item) => {
      if (item.existingGradeId && !updateExisting) {
        ignored++;
        return;
      }
      saveGrade(req.user!.id, item.assignmentId, item.enrollmentId, item.score, optionalText(item.comments, 1000), "Importación desde archivo");
      if (item.existingGradeId) updated++;
      else created++;
    });
    run(
      `UPDATE grade_imports SET status = 'applied', applied_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT id FROM grade_imports WHERE file_name = ? AND imported_by = ? ORDER BY id DESC LIMIT 1)`,
      preview.fileName,
      req.user!.id
    );
  });
  previews.delete(previewId);
  logActivity(req, "apply-import", "grades", previewId, { created, updated, ignored });
  res.json({ message: "Calificaciones importadas.", created, updated, ignored, errors: preview.errors.length });
});

gradesRouter.get("/export/file", requirePermission("grades.export"), (req, res) => {
  const clauses = ["1 = 1"];
  const params: number[] = [];
  const filters: Array<[string, unknown]> = [
    ["e.student_id", req.query.studentId], ["e.group_id", req.query.groupId],
    ["e.shift_id", req.query.shiftId], ["e.program_id", req.query.programId],
    ["a.subject_id", req.query.subjectId], ["a.teacher_id", req.query.teacherId],
    ["a.period_id", req.query.periodId], ["e.cycle_id", req.query.cycleId]
  ];
  filters.forEach(([column, input]) => {
    if (input) {
      clauses.push(`${column} = ?`);
      params.push(Number(input));
    }
  });
  const records = all<any>(
    `SELECT st.student_number AS "Matrícula",
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS "Alumno",
     p.name AS "Programa", sh.name AS "Turno", g.name AS "Grupo", s.name AS "Materia",
     t.full_name AS "Docente", ap.name AS "Periodo", sc.name AS "Ciclo",
     gr.final_score AS "Calificación", gr.status AS "Estatus", gr.comments AS "Observaciones"
     FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id
     JOIN students st ON st.id = e.student_id JOIN programs p ON p.id = e.program_id
     JOIN shifts sh ON sh.id = e.shift_id JOIN groups g ON g.id = e.group_id
     JOIN school_cycles sc ON sc.id = e.cycle_id
     JOIN subject_assignments a ON a.id = gr.assignment_id JOIN subjects s ON s.id = a.subject_id
     JOIN teachers t ON t.id = a.teacher_id JOIN academic_periods ap ON ap.id = a.period_id
     WHERE ${clauses.join(" AND ")} ORDER BY g.name, st.last_name, s.name`,
    ...params
  );
  const format = String(req.query.format ?? "xlsx");
  if (format === "csv") {
    const headers = Object.keys(records[0] ?? {});
    return sendCsv(res, "calificaciones.csv", headers, records.map((row) => headers.map((header) => row[header])));
  }
  if (format === "pdf") {
    const doc = createPdf(res, "calificaciones.pdf", { layout: "landscape" });
    doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(18).text("Concentrado de calificaciones");
    doc.moveDown();
    pdfTable(doc, ["Matrícula", "Alumno", "Grupo", "Materia", "Periodo", "Calif."], records.map((row) => [
      row["Matrícula"], row.Alumno, row.Grupo, row.Materia, row.Periodo, row["Calificación"]
    ]), [70, 180, 60, 180, 100, 50]);
    return doc.end();
  }
  return sendWorkbook(res, "calificaciones.xlsx", "Calificaciones", records);
});
