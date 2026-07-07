import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requirePermission } from "../auth.js";
import { all, get } from "../db.js";
import { createPdf, pdfTable, sendWorkbook } from "../services/files.js";
import { ApiError, asId } from "../utils.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const reportsRouter = Router();

function logoFile(logoPath: string | null) {
  if (!logoPath) return null;
  const relative = logoPath.startsWith("/assets/") ? path.join("public", logoPath) : logoPath;
  const resolved = path.resolve(projectRoot, `.${relative.startsWith("/") ? relative : `/${relative}`}`);
  return fs.existsSync(resolved) ? resolved : null;
}

function drawReportCard(doc: PDFKit.PDFDocument, studentId: number, periodId?: number) {
  const settings = get<any>("SELECT * FROM institution_settings WHERE id = 1")!;
  const student = get<any>(
    `SELECT st.id, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS name,
     p.name AS program_name, sh.name AS shift_name, g.name AS group_name, sc.name AS cycle_name
     FROM students st JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
     JOIN programs p ON p.id = e.program_id JOIN shifts sh ON sh.id = e.shift_id
     JOIN groups g ON g.id = e.group_id JOIN school_cycles sc ON sc.id = e.cycle_id WHERE st.id = ?`,
    studentId
  );
  if (!student) throw new ApiError(404, "No se encontró el alumno.");
  const params: number[] = [studentId];
  let periodClause = "";
  if (periodId) {
    periodClause = "AND ap.id = ?";
    params.push(periodId);
  }
  const grades = all<any>(
    `SELECT s.name AS subject_name, ps.recommended_period AS semester,
     CASE WHEN a.grade_entry_locked = 1 THEN 'ORDINARIO' ELSE ap.name END AS period_name,
     gr.final_score, gr.status, gr.comments, gs.passing_score
     FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id
     JOIN subject_assignments a ON a.id = gr.assignment_id JOIN subjects s ON s.id = a.subject_id
     JOIN academic_periods ap ON ap.id = a.period_id JOIN grading_scales gs ON gs.id = a.grading_scale_id
     LEFT JOIN plan_subjects ps ON ps.plan_id = e.plan_id AND ps.subject_id = s.id
     WHERE e.student_id = ? ${periodClause}
     ORDER BY COALESCE(ps.recommended_period, 999), s.name, ap.sequence`,
    ...params
  );
  const average = grades.length ? grades.reduce((sum, item) => sum + Number(item.final_score ?? 0), 0) / grades.length : null;
  const failed = grades.some((item) => item.final_score != null && item.final_score < item.passing_score);
  const status = grades.some((item) => item.final_score == null) ? "Pendiente" : failed ? "Reprobado" : "Aprobado";
  const primary = settings.primary_color || "#102a43";
  const secondary = settings.secondary_color || "#f97360";

  const logo = logoFile(settings.logo_path);
  if (logo) doc.image(logo, 42, 36, { fit: [70, 70] });
  doc.fillColor(primary).font("Helvetica-Bold").fontSize(19).text(settings.institution_name, 125, 44);
  doc.fillColor("#627d98").font("Helvetica").fontSize(9).text(settings.address || "", 125, 70);
  doc.text(`${settings.phone || ""}  ${settings.email || ""}`, 125, 84);
  doc.moveTo(42, 116).lineTo(570, 116).lineWidth(3).strokeColor(secondary).stroke();
  doc.fillColor(primary).font("Helvetica-Bold").fontSize(16).text("Boleta de calificaciones", 42, 134);
  doc.fillColor("#334e68").font("Helvetica").fontSize(10);
  doc.text(`Alumno: ${student.name}`, 42, 166);
  doc.text(`Matrícula: ${student.student_number}`, 340, 166);
  doc.text(`Programa: ${student.program_name}`, 42, 184);
  doc.text(`Turno: ${student.shift_name}`, 340, 184);
  doc.text(`Grupo: ${student.group_name}`, 42, 202);
  doc.text(`Ciclo: ${student.cycle_name}`, 340, 202);
  doc.y = 232;
  pdfTable(doc, ["Semestre", "Materia", "Evaluación", "Calificación", "Estatus"], grades.map((grade) => [
    grade.semester == null ? "—" : String(grade.semester),
    grade.subject_name,
    grade.period_name,
    grade.final_score == null ? "Pendiente" : Number(grade.final_score).toFixed(1),
    grade.final_score == null ? "Pendiente" : grade.status === "passed" ? "Aprobada" : "Reprobada"
  ]), [55, 185, 105, 80, 103]);
  doc.moveDown(1);
  doc.fillColor(primary).font("Helvetica-Bold").fontSize(12).text(
    `Promedio general: ${average == null ? "Pendiente" : average.toFixed(1)}    Estatus: ${status}`,
    { align: "right" }
  );
  const comments = grades.map((grade) => grade.comments).filter(Boolean).join(" · ");
  if (comments) {
    doc.moveDown().fillColor("#486581").font("Helvetica").fontSize(9).text(`Observaciones: ${comments}`);
  }
  const signatureY = Math.max(doc.y + 48, 620);
  doc.moveTo(80, signatureY).lineTo(260, signatureY).strokeColor("#9fb3c8").stroke();
  doc.moveTo(350, signatureY).lineTo(530, signatureY).stroke();
  doc.fillColor("#627d98").fontSize(8).text(settings.director_name || "Responsable académico", 80, signatureY + 6, { width: 180, align: "center" });
  doc.text("Firma del padre, madre o tutor", 350, signatureY + 6, { width: 180, align: "center" });
  doc.fontSize(7).text(settings.footer_text || "", 42, 735, { width: 528, align: "center" });
  doc.text(`Fecha de emisión: ${new Date().toLocaleDateString("es-MX")}`, 42, 747, { width: 528, align: "center" });
}

reportsRouter.get("/report-card.pdf", requirePermission("reports.generate"), (req, res) => {
  const studentId = req.query.studentId ? asId(req.query.studentId, "Alumno") : null;
  const groupId = req.query.groupId ? asId(req.query.groupId, "Grupo") : null;
  const periodId = req.query.periodId ? asId(req.query.periodId, "Periodo") : undefined;
  if (!studentId && !groupId) throw new ApiError(400, "Selecciona un alumno o grupo.");
  const studentIds = studentId
    ? [studentId]
    : all<{ id: number }>(
      `SELECT st.id FROM students st JOIN enrollments e ON e.student_id = st.id
       WHERE e.group_id = ? AND e.is_active = 1 AND st.is_active = 1 ORDER BY st.last_name, st.first_name`,
      groupId!
    ).map((student) => student.id);
  if (!studentIds.length) throw new ApiError(404, "El grupo no tiene alumnos activos.");
  const doc = createPdf(res, groupId ? `boletas-grupo-${groupId}.pdf` : `boleta-${studentId}.pdf`);
  studentIds.forEach((id, index) => {
    if (index) doc.addPage();
    drawReportCard(doc, id, periodId);
  });
  doc.end();
});

const reportDefinitions = {
  students: {
    title: "Lista de alumnos por grupo",
    query: `SELECT st.student_number AS Matrícula,
      TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS Alumno,
      g.name AS Grupo, p.name AS Programa, sh.name AS Turno, ss.name AS Estatus
      FROM students st JOIN student_statuses ss ON ss.id = st.status_id
      JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1 JOIN groups g ON g.id = e.group_id
      JOIN programs p ON p.id = e.program_id JOIN shifts sh ON sh.id = e.shift_id
      WHERE (? IS NULL OR e.group_id = ?) ORDER BY g.name, st.last_name`,
    headers: ["Matrícula", "Alumno", "Grupo", "Programa", "Turno", "Estatus"]
  },
  attendance: {
    title: "Lista de asistencia",
    query: `SELECT st.student_number AS Matrícula,
      TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS Alumno,
      g.name AS Grupo, '' AS Asistencia, '' AS Observaciones
      FROM students st JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
      JOIN groups g ON g.id = e.group_id WHERE (? IS NULL OR e.group_id = ?)
      ORDER BY g.name, st.last_name`,
    headers: ["Matrícula", "Alumno", "Grupo", "Asistencia", "Observaciones"]
  },
  gradebook: {
    title: "Concentrado de calificaciones",
    query: `SELECT st.student_number AS Matrícula,
      TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS Alumno,
      g.name AS Grupo, s.name AS Materia, ap.name AS Periodo, gr.final_score AS Calificación
      FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id JOIN students st ON st.id = e.student_id
      JOIN groups g ON g.id = e.group_id JOIN subject_assignments a ON a.id = gr.assignment_id
      JOIN subjects s ON s.id = a.subject_id JOIN academic_periods ap ON ap.id = a.period_id
      WHERE (? IS NULL OR e.group_id = ?) ORDER BY g.name, st.last_name, s.name`,
    headers: ["Matrícula", "Alumno", "Grupo", "Materia", "Periodo", "Calificación"]
  },
  subjects: {
    title: "Reporte por materia",
    query: `SELECT s.code AS Clave, s.name AS Materia, g.name AS Grupo,
      COUNT(gr.id) AS Evaluaciones, ROUND(AVG(gr.final_score), 2) AS Promedio,
      SUM(CASE WHEN gr.final_score < gs.passing_score THEN 1 ELSE 0 END) AS Reprobadas
      FROM subject_assignments a JOIN subjects s ON s.id = a.subject_id JOIN groups g ON g.id = a.group_id
      JOIN grading_scales gs ON gs.id = a.grading_scale_id LEFT JOIN grades gr ON gr.assignment_id = a.id
      WHERE (? IS NULL OR a.group_id = ?) GROUP BY s.id, s.code, s.name, g.name ORDER BY s.name, g.name`,
    headers: ["Clave", "Materia", "Grupo", "Evaluaciones", "Promedio", "Reprobadas"]
  },
  teachers: {
    title: "Reporte por docente",
    query: `SELECT t.employee_number AS Clave, t.full_name AS Docente, s.name AS Materia,
      g.name AS Grupo, COUNT(gr.id) AS Evaluaciones, ROUND(AVG(gr.final_score), 2) AS Promedio
      FROM subject_assignments a JOIN teachers t ON t.id = a.teacher_id JOIN subjects s ON s.id = a.subject_id
      JOIN groups g ON g.id = a.group_id LEFT JOIN grades gr ON gr.assignment_id = a.id
      WHERE (? IS NULL OR a.group_id = ?) GROUP BY t.id, t.employee_number, t.full_name, s.name, g.name
      ORDER BY t.full_name, s.name`,
    headers: ["Clave", "Docente", "Materia", "Grupo", "Evaluaciones", "Promedio"]
  },
  failed: {
    title: "Alumnos reprobados",
    query: `SELECT st.student_number AS Matrícula,
      TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS Alumno,
      g.name AS Grupo, s.name AS Materia, gr.final_score AS Calificación
      FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id JOIN students st ON st.id = e.student_id
      JOIN groups g ON g.id = e.group_id JOIN subject_assignments a ON a.id = gr.assignment_id
      JOIN subjects s ON s.id = a.subject_id JOIN grading_scales gs ON gs.id = a.grading_scale_id
      WHERE gr.final_score < gs.passing_score AND (? IS NULL OR e.group_id = ?)
      ORDER BY g.name, st.last_name, s.name`,
    headers: ["Matrícula", "Alumno", "Grupo", "Materia", "Calificación"]
  },
  outstanding: {
    title: "Alumnos destacados",
    query: `SELECT st.student_number AS Matrícula,
      TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS Alumno,
      g.name AS Grupo, ROUND(AVG(gr.final_score), 2) AS Promedio
      FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id JOIN students st ON st.id = e.student_id
      JOIN groups g ON g.id = e.group_id WHERE (? IS NULL OR e.group_id = ?)
      GROUP BY st.id, st.student_number, Alumno, g.name HAVING AVG(gr.final_score) >= 9
      ORDER BY Promedio DESC`,
    headers: ["Matrícula", "Alumno", "Grupo", "Promedio"]
  }
} as const;

reportsRouter.get("/data/:type", requirePermission("reports.view"), (req, res) => {
  const definition = reportDefinitions[req.params.type as keyof typeof reportDefinitions];
  if (!definition) throw new ApiError(404, "El reporte solicitado no existe.");
  const groupId = req.query.groupId ? Number(req.query.groupId) : null;
  const records = all<any>(definition.query, groupId, groupId);
  if (req.query.format === "xlsx") return sendWorkbook(res, `${req.params.type}.xlsx`, "Reporte", records);
  const doc = createPdf(res, `${req.params.type}.pdf`, { layout: "landscape" });
  doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(18).text(definition.title);
  doc.moveDown(0.3).fillColor("#627d98").font("Helvetica").fontSize(9).text(`Generado: ${new Date().toLocaleString("es-MX")}`);
  doc.moveDown();
  pdfTable(doc, [...definition.headers], records.map((row) => definition.headers.map((header) => row[header])));
  doc.end();
});
