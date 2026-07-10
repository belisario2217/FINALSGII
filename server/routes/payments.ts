import { Router } from "express";
import crypto from "node:crypto";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { buildBilling, type BillingSource } from "../services/billing.js";
import { createPdf, parseWorkbook, pdfTable, sendWorkbook, type TabularRow } from "../services/files.js";
import { ApiError, asId, asNumber, cleanText, optionalText, sendCsv } from "../utils.js";
import multer from "multer";

export const paymentsRouter = Router();

type StudentAccount = BillingSource & {
  student_number: string;
  student_name: string;
  email: string | null;
  program_name: string;
  group_name: string;
  shift_name: string;
  cycle_name: string;
  current_period: string | null;
  plan_name: string | null;
  plan_code: string | null;
  level_name: string | null;
  billingStartDate: string | null;
  tuitionDueDay: number | null;
};

type PaymentImportRow = {
  row: number;
  studentId: number;
  studentNumber: string;
  studentName: string;
  folio: string;
  amount: number;
  paidAt: string;
  paymentMethod: string | null;
  concept: string;
  notes: string | null;
  existingPaymentId: number | null;
};

type PaymentPreview = {
  createdAt: number;
  valid: PaymentImportRow[];
  errors: Array<{ row: number; message: string }>;
};

const paymentPreviews = new Map<string, PaymentPreview>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (/\.(xlsx|xls|csv)$/i.test(file.originalname)) callback(null, true);
    else callback(new ApiError(400, "Usa un archivo Excel o CSV."));
  }
});

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

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

function parseAmount(value: unknown) {
  const text = cleanText(value, 40).replace(/\$/g, "").replace(/,/g, "").trim();
  return Number(text);
}

function money(value: unknown) {
  return Number(value ?? 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function validDate(value: unknown, field: string) {
  const text = cleanText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00`).getTime())) {
    return text;
  }
  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!Number.isNaN(new Date(`${normalized}T00:00:00`).getTime())) return normalized;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 30_000 && serial < 80_000) {
      const date = new Date(Date.UTC(1899, 11, 30 + Math.trunc(serial)));
      return date.toISOString().slice(0, 10);
    }
  }
  throw new ApiError(400, `${field} no es una fecha valida.`);
}

function validMonth(value: unknown) {
  const text = cleanText(value || currentMonth(), 7);
  if (!/^\d{4}-\d{2}$/.test(text)) throw new ApiError(400, "El mes debe tener formato AAAA-MM.");
  return text;
}

function validDueDay(value: unknown) {
  const day = Math.trunc(asNumber(value, "Dia de cargo"));
  if (day < 1 || day > 31) throw new ApiError(400, "El dia de cargo debe estar entre 1 y 31.");
  return day;
}

function getStudentAccount(studentId: number) {
  return get<StudentAccount>(
    `SELECT e.id AS enrollmentId, e.student_id AS studentId, e.plan_id AS planId,
     p.duration_periods AS durationPeriods, ap.tuition_amount AS tuitionAmount,
     e.enrolled_at AS enrolledAt, COALESCE(e.tuition_start_date, sc.start_date) AS billingStartDate,
     e.tuition_due_day AS tuitionDueDay, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
     st.email, p.name AS program_name, g.name AS group_name, sh.name AS shift_name,
     sc.name AS cycle_name, period.name AS current_period, ap.name AS plan_name,
     ap.code AS plan_code, l.name AS level_name
     FROM enrollments e
     JOIN students st ON st.id = e.student_id
     JOIN programs p ON p.id = e.program_id
     LEFT JOIN academic_levels l ON l.id = p.level_id
     JOIN groups g ON g.id = e.group_id
     JOIN shifts sh ON sh.id = e.shift_id
     JOIN school_cycles sc ON sc.id = e.cycle_id
     LEFT JOIN academic_periods period ON period.id = e.period_id
     LEFT JOIN academic_plans ap ON ap.id = e.plan_id
     WHERE e.student_id = ? AND e.is_active = 1
     ORDER BY e.id DESC LIMIT 1`,
    studentId
  );
}

function academicProgress(account: StudentAccount) {
  const planSubjects = account.planId ? all<any>(
    `SELECT ps.subject_id, ps.credits FROM plan_subjects ps WHERE ps.plan_id = ?`,
    account.planId
  ) : [];
  const explicitRows = all<any>(
    `SELECT ss.subject_id, ss.credits, ss.status, ss.final_score
     FROM student_subjects ss
     WHERE ss.student_id = ?`,
    account.studentId
  );
  const gradeRows = all<any>(
    `SELECT s.id AS subject_id, COALESCE(NULLIF(s.credits, 0), 1) AS subject_credits,
     gr.final_score, gr.status, gs.passing_score
     FROM grades gr
     JOIN subject_assignments a ON a.id = gr.assignment_id
     JOIN subjects s ON s.id = a.subject_id
     JOIN grading_scales gs ON gs.id = a.grading_scale_id
     WHERE gr.enrollment_id = ?`,
    account.enrollmentId ?? 0
  );
  const subjects = planSubjects.length ? planSubjects : gradeRows
    .filter((grade, index, list) => list.findIndex((item) => item.subject_id === grade.subject_id) === index)
    .map((grade) => ({ subject_id: grade.subject_id, credits: grade.subject_credits }));
  const totalCredits = subjects.reduce((sum, subject) => sum + Number(subject.credits), 0);
  const passedSubjects = subjects.filter((subject) => {
    const explicit = explicitRows.find((row) => row.subject_id === subject.subject_id);
    if (explicit?.status === "completed" && explicit.final_score != null) return true;
    return gradeRows.some((grade) =>
      grade.subject_id === subject.subject_id &&
      grade.final_score != null &&
      (grade.status === "passed" || Number(grade.final_score) >= Number(grade.passing_score ?? 0))
    );
  });
  const earnedCredits = passedSubjects.reduce((sum, subject) => sum + Number(subject.credits), 0);
  const scored = [
    ...explicitRows.filter((row) => row.final_score != null),
    ...gradeRows.filter((grade) => grade.final_score != null && !explicitRows.some((row) => row.subject_id === grade.subject_id))
  ];
  const average = scored.length
    ? scored.reduce((sum, grade) => sum + Number(grade.final_score), 0) / scored.length
    : null;
  return {
    totalCredits,
    earnedCredits,
    percentage: totalCredits ? Number((earnedCredits / totalCredits * 100).toFixed(1)) : 0,
    average: average == null ? null : Number(average.toFixed(1))
  };
}

function fullAccount(studentId: number) {
  const account = getStudentAccount(studentId);
  if (!account) throw new ApiError(404, "No se encontro una inscripcion activa para este alumno.");
  return {
    student: account,
    progress: academicProgress(account),
    billing: buildBilling(account)
  };
}

function normalizedPaymentBody(body: any) {
  const folio = cleanText(body.folio, 80).toUpperCase();
  const amount = asNumber(body.amount, "Monto");
  if (!folio) throw new ApiError(400, "El folio es obligatorio.");
  if (amount <= 0) throw new ApiError(400, "El monto debe ser mayor a cero.");
  return {
    folio,
    amount,
    paidAt: validDate(body.paidAt, "Fecha de pago"),
    paymentMethod: optionalText(body.paymentMethod, 80),
    concept: cleanText(body.concept || "Colegiatura", 120) || "Colegiatura",
    notes: optionalText(body.notes, 800)
  };
}

function reportRows(month: string, groupId?: number) {
  const params: Array<string | number> = [month];
  const clauses = ["substr(sp.paid_at, 1, 7) = ?"];
  if (groupId) {
    clauses.push("e.group_id = ?");
    params.push(groupId);
  }
  return all<any>(
    `SELECT sp.folio, sp.paid_at, sp.amount, sp.payment_method, sp.concept,
     st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
     p.name AS program_name, g.name AS group_name, ap.name AS plan_name
     FROM student_payments sp
     JOIN students st ON st.id = sp.student_id
     LEFT JOIN enrollments e ON e.id = sp.enrollment_id
     LEFT JOIN programs p ON p.id = e.program_id
     LEFT JOIN groups g ON g.id = e.group_id
     LEFT JOIN academic_plans ap ON ap.id = sp.plan_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY sp.paid_at, sp.folio`,
    ...params
  );
}

function drawStatementPdf(res: any, accountData: ReturnType<typeof fullAccount>) {
  const doc = createPdf(res, `estado-de-cuenta-${accountData.student.student_number}.pdf`);
  const { student, progress, billing } = accountData;
  doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(19).text("Estado de cuenta");
  doc.moveDown(0.25).fillColor("#627d98").font("Helvetica").fontSize(9)
    .text(`Alumno: ${student.student_name}  |  Matricula: ${student.student_number}`)
    .text(`Programa: ${student.program_name}  |  Grupo: ${student.group_name}  |  Plan: ${student.plan_name ?? "Sin plan"}`);
  doc.moveDown();
  pdfTable(doc, ["Colegiatura", "Esperado", "Pagado", "Adeudo", "Avance"], [[
    money(billing.summary.tuitionAmount),
    money(billing.summary.expectedAmount),
    money(billing.summary.paidAmount),
    money(billing.summary.balance),
    `${progress.percentage}%`
  ]], [95, 105, 105, 105, 90]);
  doc.moveDown();
  doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(12).text("Pagos registrados");
  doc.moveDown(0.4);
  pdfTable(doc, ["Folio", "Fecha", "Concepto", "Metodo", "Monto"], billing.payments.map((payment) => [
    payment.folio, payment.paid_at, payment.concept, payment.payment_method ?? "-", money(payment.amount)
  ]), [90, 78, 155, 92, 88]);
  doc.moveDown();
  doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(12).text("Colegiaturas esperadas");
  doc.moveDown(0.4);
  pdfTable(doc, ["Periodo", "Vence", "Esperado", "Pagado", "Pendiente", "Estatus"], billing.schedule.map((item) => [
    item.period, item.dueDate ?? "-", money(item.expectedAmount), money(item.paidAmount), money(item.pendingAmount),
    item.status === "paid" ? "Pagado" : item.status === "partial" ? "Parcial" : "Pendiente"
  ]), [55, 82, 92, 92, 92, 90]);
  doc.fontSize(7).fillColor("#627d98").text(`Generado: ${new Date().toLocaleString("es-MX")}`, 42, 747, { width: 528, align: "center" });
  doc.end();
}

paymentsRouter.get("/students", requirePermission("payments.view"), (req, res) => {
  const search = cleanText(req.query.search, 120);
  const like = `%${search}%`;
  res.json({
    records: all(
      `SELECT st.id, st.student_number,
       TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS name,
       p.name AS program_name, g.name AS group_name, sh.name AS shift_name,
       ap.name AS plan_name, ap.tuition_amount
       FROM students st
       JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
       JOIN programs p ON p.id = e.program_id
       JOIN groups g ON g.id = e.group_id
       JOIN shifts sh ON sh.id = e.shift_id
       LEFT JOIN academic_plans ap ON ap.id = e.plan_id
       WHERE st.is_active = 1 AND (? = '' OR st.student_number LIKE ? OR
         TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) LIKE ?)
       ORDER BY st.last_name, st.first_name LIMIT 20`,
      search,
      like,
      like
    )
  });
});

paymentsRouter.get("/template/import.xlsx", requirePermission("payments.manage"), (_req, res) => {
  sendWorkbook(res, "plantilla-pagos.xlsx", "Pagos", [{
    Matricula: "0825AMRLEESC",
    Folio: "PAGO-0001",
    Fecha: "2026-07-08",
    Monto: 1500,
    Metodo: "Transferencia",
    Concepto: "Colegiatura",
    Observaciones: ""
  }, {
    Matricula: "0825AMRLEESC",
    Folio: "",
    Fecha: "2026-08-08",
    Monto: 1500,
    Metodo: "Efectivo",
    Concepto: "Colegiatura",
    Observaciones: "Folio vacio: el sistema genera uno automaticamente"
  }]);
});

paymentsRouter.post("/import/preview", requirePermission("payments.manage"), upload.single("file"), (req: AuthenticatedRequest, res) => {
  if (!req.file) throw new ApiError(400, "Selecciona un archivo.");
  const rows = parseWorkbook(req.file.buffer);
  if (!rows.length) throw new ApiError(400, "El archivo no contiene filas.");
  if (rows.length > 3000) throw new ApiError(400, "El archivo excede el limite de 3,000 filas.");
  const valid: PaymentImportRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  rows.forEach((source, index) => {
    const rowNumber = index + 2;
    const studentNumber = value(source, "Matricula", "Matrícula");
    const folioInput = value(source, "Folio", "Recibo", "Referencia").toUpperCase();
    const paidAtInput = value(source, "Fecha de pago", "Fecha");
    const amountInput = value(source, "Monto", "Importe");
    if (!studentNumber || !paidAtInput || amountInput === "") {
      errors.push({ row: rowNumber, message: "Faltan matricula, fecha o monto." });
      return;
    }
    const amount = parseAmount(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ row: rowNumber, message: "El monto debe ser numerico y mayor a cero." });
      return;
    }
    let paidAt = "";
    try {
      paidAt = validDate(paidAtInput, "Fecha de pago");
    } catch {
      errors.push({ row: rowNumber, message: "La fecha debe estar en formato AAAA-MM-DD." });
      return;
    }
    const account = get<StudentAccount>(
      `SELECT e.id AS enrollmentId, e.student_id AS studentId, e.plan_id AS planId,
       p.duration_periods AS durationPeriods, ap.tuition_amount AS tuitionAmount,
       e.enrolled_at AS enrolledAt, COALESCE(e.tuition_start_date, sc.start_date) AS billingStartDate,
       e.tuition_due_day AS tuitionDueDay, st.student_number,
       TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
       st.email, p.name AS program_name, g.name AS group_name, sh.name AS shift_name,
       sc.name AS cycle_name, period.name AS current_period, ap.name AS plan_name,
       ap.code AS plan_code, l.name AS level_name
       FROM students st
       JOIN enrollments e ON e.student_id = st.id AND e.is_active = 1
       JOIN programs p ON p.id = e.program_id
       LEFT JOIN academic_levels l ON l.id = p.level_id
       JOIN groups g ON g.id = e.group_id
       JOIN shifts sh ON sh.id = e.shift_id
       JOIN school_cycles sc ON sc.id = e.cycle_id
       LEFT JOIN academic_periods period ON period.id = e.period_id
       LEFT JOIN academic_plans ap ON ap.id = e.plan_id
       WHERE st.student_number = ? AND st.is_active = 1
       ORDER BY e.id DESC LIMIT 1`,
      studentNumber
    );
    if (!account) {
      errors.push({ row: rowNumber, message: "No se encontro alumno activo con esa matricula." });
      return;
    }
    const folio = folioInput || `IMP-${studentNumber}-${paidAt.replaceAll("-", "")}-${rowNumber}`;
    const existing = get<{ id: number }>("SELECT id FROM student_payments WHERE folio = ?", folio);
    valid.push({
      row: rowNumber,
      studentId: account.studentId,
      studentNumber,
      studentName: account.student_name,
      folio,
      amount,
      paidAt,
      paymentMethod: optionalText(value(source, "Metodo", "Método"), 80),
      concept: cleanText(value(source, "Concepto") || "Colegiatura", 120) || "Colegiatura",
      notes: optionalText(value(source, "Notas", "Observaciones"), 800),
      existingPaymentId: existing?.id ?? null
    });
  });
  const previewId = crypto.randomUUID();
  paymentPreviews.set(previewId, { createdAt: Date.now(), valid, errors });
  logActivity(req, "preview-import", "student_payments", previewId, { total: rows.length, valid: valid.length, errors: errors.length });
  res.json({
    previewId,
    summary: { total: rows.length, valid: valid.length, errors: errors.length, existing: valid.filter((row) => row.existingPaymentId).length },
    rows: valid.slice(0, 150),
    errors: errors.slice(0, 150)
  });
});

paymentsRouter.post("/import/apply", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const previewId = String(req.body.previewId ?? "");
  const preview = paymentPreviews.get(previewId);
  if (!preview || Date.now() - preview.createdAt > 15 * 60 * 1000) throw new ApiError(400, "La vista previa expiro. Carga el archivo de nuevo.");
  const updateExisting = req.body.existingMode === "update";
  let created = 0;
  let updated = 0;
  let ignored = 0;
  transaction(() => {
    preview.valid.forEach((item) => {
      const account = getStudentAccount(item.studentId);
      if (!account) {
        ignored++;
        return;
      }
      if (item.existingPaymentId) {
        if (!updateExisting) {
          ignored++;
          return;
        }
        run(
          `UPDATE student_payments SET student_id = ?, enrollment_id = ?, plan_id = ?, amount = ?, paid_at = ?,
           payment_method = ?, concept = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          item.studentId,
          account.enrollmentId,
          account.planId,
          item.amount,
          item.paidAt,
          item.paymentMethod,
          item.concept,
          item.notes,
          req.user!.id,
          item.existingPaymentId
        );
        updated++;
        return;
      }
      run(
        `INSERT INTO student_payments(student_id, enrollment_id, plan_id, folio, amount, paid_at,
         payment_method, concept, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.studentId,
        account.enrollmentId,
        account.planId,
        item.folio,
        item.amount,
        item.paidAt,
        item.paymentMethod,
        item.concept,
        item.notes,
        req.user!.id,
        req.user!.id
      );
      created++;
    });
  });
  paymentPreviews.delete(previewId);
  logActivity(req, "apply-import", "student_payments", previewId, { created, updated, ignored });
  res.json({ created, updated, ignored, errors: preview.errors.length });
});

paymentsRouter.post("/billing-config/group", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const groupId = asId(req.body.groupId, "Grupo");
  const startDate = validDate(req.body.startDate, "Inicio de cobro");
  const dueDay = validDueDay(req.body.dueDay);
  const result = run(
    `UPDATE enrollments SET tuition_start_date = ?, tuition_due_day = ?
     WHERE group_id = ? AND is_active = 1`,
    startDate,
    dueDay,
    groupId
  );
  logActivity(req, "update-group-billing-config", "enrollments", groupId, { startDate, dueDay, count: Number(result.changes) });
  res.json({ count: Number(result.changes), startDate, dueDay });
});

paymentsRouter.patch("/student/:id/billing-config", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const studentId = asId(req.params.id, "Alumno");
  const startDate = validDate(req.body.startDate, "Inicio de cobro");
  const dueDay = validDueDay(req.body.dueDay);
  run(
    `UPDATE enrollments SET tuition_start_date = ?, tuition_due_day = ?
     WHERE student_id = ? AND is_active = 1`,
    startDate,
    dueDay,
    studentId
  );
  logActivity(req, "update-student-billing-config", "enrollments", studentId, { startDate, dueDay });
  res.json(fullAccount(studentId));
});

paymentsRouter.get("/overview", requirePermission("payments.view"), (req, res) => {
  const month = validMonth(req.query.month);
  const records = reportRows(month);
  const groups = records.reduce<Record<string, { groupName: string; count: number; amount: number }>>((map, row) => {
    const key = row.group_name ?? "Sin grupo";
    map[key] ??= { groupName: key, count: 0, amount: 0 };
    map[key].count += 1;
    map[key].amount += Number(row.amount);
    return map;
  }, {});
  res.json({
    month,
    summary: {
      count: records.length,
      amount: Number(records.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2))
    },
    groups: Object.values(groups).map((group) => ({ ...group, amount: Number(group.amount.toFixed(2)) }))
  });
});

paymentsRouter.get("/student/:id", requirePermission("payments.view"), (req, res) => {
  res.json(fullAccount(asId(req.params.id, "Alumno")));
});

paymentsRouter.get("/student/:id/statement", requirePermission("payments.export"), (req, res) => {
  const data = fullAccount(asId(req.params.id, "Alumno"));
  const format = cleanText(req.query.format || "pdf", 10);
  if (format === "xlsx") {
    return sendWorkbook(res, `estado-de-cuenta-${data.student.student_number}.xlsx`, "Estado de cuenta", data.billing.payments.map((payment) => ({
      Folio: payment.folio,
      Fecha: payment.paid_at,
      Concepto: payment.concept,
      Metodo: payment.payment_method ?? "",
      Monto: payment.amount
    })));
  }
  return drawStatementPdf(res, data);
});

paymentsRouter.get("/report", requirePermission("payments.export"), (req, res) => {
  const month = validMonth(req.query.month);
  const groupId = req.query.groupId ? asId(req.query.groupId, "Grupo") : undefined;
  const records = reportRows(month, groupId).map((row) => ({
    Folio: row.folio,
    Fecha: row.paid_at,
    Matricula: row.student_number,
    Alumno: row.student_name,
    Grupo: row.group_name ?? "",
    Plan: row.plan_name ?? "",
    Concepto: row.concept,
    Metodo: row.payment_method ?? "",
    Monto: row.amount
  }));
  const format = cleanText(req.query.format || "pdf", 10);
  if (format === "xlsx") return sendWorkbook(res, `estado-de-cuenta-${month}.xlsx`, "Estado de cuenta", records);
  if (format === "csv") return sendCsv(res, `estado-de-cuenta-${month}.csv`, Object.keys(records[0] ?? {}), records.map((row) => Object.values(row)));
  const doc = createPdf(res, `estado-de-cuenta-${month}.pdf`, { layout: "landscape" });
  const total = records.reduce((sum, row) => sum + Number(row.Monto), 0);
  doc.fillColor("#102a43").font("Helvetica-Bold").fontSize(19).text("Estado de cuenta");
  doc.moveDown(0.2).fillColor("#627d98").font("Helvetica").fontSize(9)
    .text(`Periodo mensual: ${month}  |  Cobros: ${records.length}  |  Total: ${money(total)}`);
  doc.moveDown();
  pdfTable(doc, ["Folio", "Fecha", "Matricula", "Alumno", "Grupo", "Monto"], records.map((row) => [
    row.Folio, row.Fecha, row.Matricula, row.Alumno, row.Grupo, money(row.Monto)
  ]), [92, 72, 92, 210, 82, 82]);
  doc.fontSize(7).fillColor("#627d98").text(`Generado: ${new Date().toLocaleString("es-MX")}`, 42, 555, { width: 708, align: "center" });
  doc.end();
});

paymentsRouter.post("/", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const studentId = asId(req.body.studentId, "Alumno");
  const account = getStudentAccount(studentId);
  if (!account) throw new ApiError(404, "No se encontro una inscripcion activa para este alumno.");
  const body = normalizedPaymentBody(req.body);
  const id = transaction(() => {
    const inserted = run(
      `INSERT INTO student_payments(student_id, enrollment_id, plan_id, folio, amount, paid_at,
       payment_method, concept, notes, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      studentId,
      account.enrollmentId,
      account.planId,
      body.folio,
      body.amount,
      body.paidAt,
      body.paymentMethod,
      body.concept,
      body.notes,
      req.user!.id,
      req.user!.id
    );
    return Number(inserted.lastInsertRowid);
  });
  logActivity(req, "create", "student_payments", id, { studentId, folio: body.folio, amount: body.amount });
  res.status(201).json(fullAccount(studentId));
});

paymentsRouter.patch("/:id", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Pago");
  const current = get<{ student_id: number }>("SELECT student_id FROM student_payments WHERE id = ?", id);
  if (!current) throw new ApiError(404, "No se encontro el pago.");
  const body = normalizedPaymentBody(req.body);
  run(
    `UPDATE student_payments SET folio = ?, amount = ?, paid_at = ?, payment_method = ?,
     concept = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    body.folio,
    body.amount,
    body.paidAt,
    body.paymentMethod,
    body.concept,
    body.notes,
    req.user!.id,
    id
  );
  logActivity(req, "update", "student_payments", id, { folio: body.folio, amount: body.amount });
  res.json(fullAccount(current.student_id));
});

paymentsRouter.delete("/:id", requirePermission("payments.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Pago");
  const payment = get<{ student_id: number; folio: string; amount: number }>("SELECT student_id, folio, amount FROM student_payments WHERE id = ?", id);
  if (!payment) throw new ApiError(404, "El pago ya no existe.");
  run("DELETE FROM student_payments WHERE id = ?", id);
  logActivity(req, "delete", "student_payments", id, payment);
  res.status(204).end();
});
