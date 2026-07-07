import { Router } from "express";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { buildBilling, type BillingSource } from "../services/billing.js";
import { createPdf, pdfTable, sendWorkbook } from "../services/files.js";
import { ApiError, asId, asNumber, cleanText, optionalText, sendCsv } from "../utils.js";

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
};

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function money(value: unknown) {
  return Number(value ?? 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function validDate(value: unknown, field: string) {
  const text = cleanText(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00`).getTime())) {
    throw new ApiError(400, `${field} no es una fecha valida.`);
  }
  return text;
}

function validMonth(value: unknown) {
  const text = cleanText(value || currentMonth(), 7);
  if (!/^\d{4}-\d{2}$/.test(text)) throw new ApiError(400, "El mes debe tener formato AAAA-MM.");
  return text;
}

function getStudentAccount(studentId: number) {
  return get<StudentAccount>(
    `SELECT e.id AS enrollmentId, e.student_id AS studentId, e.plan_id AS planId,
     p.duration_periods AS durationPeriods, ap.tuition_amount AS tuitionAmount,
     e.enrolled_at AS enrolledAt, sc.start_date AS billingStartDate, st.student_number,
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
  const passedSubjects = subjects.filter((subject) => gradeRows.some((grade) =>
    grade.subject_id === subject.subject_id &&
    grade.final_score != null &&
    (grade.status === "passed" || Number(grade.final_score) >= Number(grade.passing_score ?? 0))
  ));
  const earnedCredits = passedSubjects.reduce((sum, subject) => sum + Number(subject.credits), 0);
  const scored = gradeRows.filter((grade) => grade.final_score != null);
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
