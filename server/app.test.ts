import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import * as XLSX from "xlsx";

const testDb = path.resolve("data/test-school.db");
for (const suffix of ["", "-shm", "-wal"]) {
  const file = `${testDb}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file);
}
process.env.DATABASE_PATH = testDb;
process.env.JWT_SECRET = "test-secret";

const { app } = await import("./app.js");
const { db } = await import("./db.js");

let token = "";

beforeAll(async () => {
  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "admin@aulanova.edu.mx", password: "Admin123!" });
  token = response.body.token;
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${testDb}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

describe("Aula Nova API", () => {
  it("authenticates and exposes permissions", async () => {
    const response = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.user.roleName).toBe("Administrador");
    expect(response.body.user.permissions).toContain("grades.manage");
    expect(response.body.user.permissions).toContain("payments.manage");
  });

  it("provides the student login, academic levels and curricular portal", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "alumno@campusfrontera.edu.mx", password: "Alumno123!" });
    expect(login.status).toBe(200);
    expect(login.body.user.roleName).toBe("Alumno");
    expect(login.body.user.studentId).toBeTypeOf("number");

    const studentToken = login.body.token;
    const portal = await request(app).get("/api/portal").set("Authorization", `Bearer ${studentToken}`);
    expect(portal.status).toBe(200);
    expect(portal.body.progress.totalCredits).toBeGreaterThan(0);
    expect(portal.body.subjects.length).toBeGreaterThan(0);

    const forbidden = await request(app).get("/api/grades/assignments").set("Authorization", `Bearer ${studentToken}`);
    expect(forbidden.status).toBe(403);

    const levels = await request(app).get("/api/catalogs/levels").set("Authorization", `Bearer ${token}`);
    const names = levels.body.records.map((level: any) => level.name);
    expect(names).toEqual(expect.arrayContaining(["Licenciatura", "Maestría", "Especialidad"]));
    const programs = await request(app).get("/api/catalogs/programs").set("Authorization", `Bearer ${token}`);
    const programNames = programs.body.records.map((program: any) => program.name);
    expect(programNames).toEqual(expect.arrayContaining(["Licenciatura", "Maestría", "Especialidad"]));
  });

  it("creates a three-partial assignment and calculates its average", async () => {
    const responses = await Promise.all(
      ["subjects", "groups", "teachers", "periods", "scales"].map((type) =>
        request(app).get(`/api/catalogs/${type}`).set("Authorization", `Bearer ${token}`)
      )
    );
    const [subjects, groups, teachers, periods, scales] = responses.map((response) => response.body.records);
    const created = await request(app)
      .post("/api/grades/assignments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subjectId: subjects.find((subject: any) => subject.code === "COM-101").id,
        groupId: groups.find((group: any) => group.name === "1A").id,
        teacherId: teachers[0].id,
        periodId: periods.find((period: any) => period.name === "Primer parcial").id,
        gradingScaleId: scales[0].id,
        evaluationMode: "partials"
      });
    expect(created.status).toBe(201);
    expect(created.body.evaluation_mode).toBe("partials");

    const roster = await request(app)
      .get(`/api/grades/assignment/${created.body.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    const student = roster.body.students[0];
    const saved = await request(app)
      .put(`/api/grades/assignment/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grades: [{ enrollmentId: student.enrollment_id, partials: { partial1: 8, partial2: 9, partial3: 10 } }] });
    expect(saved.status).toBe(200);

    const refreshed = await request(app)
      .get(`/api/grades/assignment/${created.body.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    const grade = refreshed.body.students.find((item: any) => item.enrollment_id === student.enrollment_id);
    expect(grade.final_score).toBe(9);
    expect(grade.status).toBe("passed");
    expect([grade.partial_1, grade.partial_2, grade.partial_3]).toEqual([8, 9, 10]);
  });

  it("creates a complete academic plan with mandatory and elective subjects", async () => {
    const programs = await request(app).get("/api/catalogs/programs").set("Authorization", `Bearer ${token}`);
    const programId = programs.body.records[0].id;
    const created = await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        programId,
        code: "PLAN-TEST-2026",
        name: "Plan automatizado",
        version: "2026",
        assignExisting: false,
        subjects: [
          { code: "PLAN-T01", name: "Fundamentos", subjectType: "mandatory", credits: 6, recommendedPeriod: 1 },
          { code: "PLAN-T02", name: "Seminario optativo", subjectType: "elective", credits: 4, recommendedPeriod: 2 }
        ]
      });
    expect(created.status).toBe(201);
    expect(created.body.total_credits).toBe(10);

    const detail = await request(app).get(`/api/plans/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(detail.body.subjects).toHaveLength(2);
    expect(detail.body.subjects.map((subject: any) => subject.subject_type)).toEqual(expect.arrayContaining(["mandatory", "elective"]));

    const updated = await request(app)
      .put(`/api/plans/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        programId,
        code: "PLAN-TEST-2026",
        name: "Plan automatizado editado",
        version: "2027",
        assignExisting: false,
        subjects: [
          { code: "PLAN-T01", name: "Fundamentos actualizados", subjectType: "mandatory", credits: 8, recommendedPeriod: 1 },
          { code: "PLAN-T02", name: "Seminario optativo", subjectType: "elective", credits: 4, recommendedPeriod: 2 }
        ]
      });
    expect(updated.status).toBe(200);
    expect(updated.body.total_credits).toBe(12);
    expect(updated.body.name).toBe("Plan automatizado editado");

    await request(app)
      .delete(`/api/plans/${created.body.id}/permanent`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    await request(app).get(`/api/plans/${created.body.id}`).set("Authorization", `Bearer ${token}`).expect(404);
  });

  it("manages student tuition payments and exports account statements", async () => {
    const programs = await request(app).get("/api/catalogs/programs").set("Authorization", `Bearer ${token}`);
    const programId = programs.body.records.find((program: any) => program.name === "Bachillerato General").id;
    await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        programId,
        code: "PAY-PLAN-2026",
        name: "Plan con colegiatura",
        version: "2026",
        tuitionAmount: 1000,
        assignExisting: true,
        subjects: [
          { code: "PAY-101", name: "Materia de control de pagos", subjectType: "mandatory", credits: 6, recommendedPeriod: 1 }
        ]
      })
      .expect(201);

    const search = await request(app)
      .get("/api/payments/students?search=AN26001")
      .set("Authorization", `Bearer ${token}`);
    expect(search.status).toBe(200);
    const studentId = search.body.records[0].id;

    const account = await request(app)
      .get(`/api/payments/student/${studentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(account.body.billing.summary.expectedAmount).toBe(6000);
    expect(account.body.billing.schedule[0].dueDate).toBe("2026-08-17");

    const created = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentId,
        folio: "FOL-PAY-001",
        amount: 1200,
        paidAt: "2026-09-03",
        paymentMethod: "Efectivo",
        concept: "Colegiatura"
      });
    expect(created.status).toBe(201);
    expect(created.body.billing.summary.paidAmount).toBe(1200);
    expect(created.body.billing.summary.balance).toBe(4800);
    const paymentId = created.body.billing.payments.find((payment: any) => payment.folio === "FOL-PAY-001").id;

    const updated = await request(app)
      .patch(`/api/payments/${paymentId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentId,
        folio: "FOL-PAY-001",
        amount: 1500,
        paidAt: "2026-09-03",
        paymentMethod: "Transferencia",
        concept: "Colegiatura"
      });
    expect(updated.status).toBe(200);
    expect(updated.body.billing.summary.paidAmount).toBe(1500);

    const report = await request(app)
      .get("/api/payments/report?month=2026-09&format=pdf")
      .set("Authorization", `Bearer ${token}`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("application/pdf");

    const statement = await request(app)
      .get(`/api/payments/student/${studentId}/statement?format=xlsx`)
      .set("Authorization", `Bearer ${token}`);
    expect(statement.status).toBe(200);
    expect(statement.headers["content-type"]).toContain("spreadsheetml");

    await request(app)
      .delete(`/api/payments/${paymentId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    const afterDelete = await request(app)
      .get(`/api/payments/student/${studentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterDelete.body.billing.summary.paidAmount).toBe(0);
  });

  it("lists editable catalogs and creates a shift", async () => {
    const list = await request(app).get("/api/catalogs").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.some((catalog: any) => catalog.key === "programs")).toBe(true);

    const created = await request(app)
      .post("/api/catalogs/shifts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mixto", start_time: "10:00", end_time: "17:00" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Mixto");
  });

  it("creates and filters a student enrollment", async () => {
    const catalogs = await Promise.all(
      ["programs", "shifts", "groups", "cycles", "periods", "statuses"].map((type) =>
        request(app).get(`/api/catalogs/${type}`).set("Authorization", `Bearer ${token}`)
      )
    );
    const [programs, shifts, groups, cycles, periods, statuses] = catalogs.map((response) => response.body.records);
    const created = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentNumber: "TEST-001",
        firstName: "Alex",
        lastName: "Prueba",
        statusId: statuses[0].id,
        programId: programs[0].id,
        shiftId: shifts.find((shift: any) => shift.name === "Matutino").id,
        groupId: groups.find((group: any) => group.name === "1A").id,
        cycleId: cycles[0].id,
        periodId: periods[0].id
      });
    expect(created.status).toBe(201);
    expect(created.body.student_number).toBe("TEST-001");

    const filtered = await request(app)
      .get("/api/students?search=TEST-001")
      .set("Authorization", `Bearer ${token}`);
    expect(filtered.body.pagination.total).toBe(1);

    await request(app)
      .delete(`/api/students/${created.body.id}/permanent`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    const removed = await request(app).get("/api/students?search=TEST-001").set("Authorization", `Bearer ${token}`);
    expect(removed.body.pagination.total).toBe(0);
  });

  it("permanently deletes an unused subject", async () => {
    const programs = await request(app).get("/api/catalogs/programs").set("Authorization", `Bearer ${token}`);
    const subject = await request(app)
      .post("/api/catalogs/subjects")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "DELETE-101", name: "Materia eliminable", program_id: programs.body.records[0].id, credits: 3, hours_per_week: 2 });
    expect(subject.status).toBe(201);
    await request(app)
      .delete(`/api/catalogs/subjects/${subject.body.id}/permanent`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);
    const subjects = await request(app).get("/api/catalogs/subjects").set("Authorization", `Bearer ${token}`);
    expect(subjects.body.records.some((item: any) => item.id === subject.body.id)).toBe(false);
  });

  it("force deletes a catalog record and its dependencies", async () => {
    const levels = await request(app).get("/api/catalogs/levels").set("Authorization", `Bearer ${token}`);
    const program = await request(app)
      .post("/api/catalogs/programs")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "FORCE-PROG", name: "Programa para borrado forzado", level_id: levels.body.records[0].id, duration_periods: 2 });
    const subject = await request(app)
      .post("/api/catalogs/subjects")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "FORCE-101", name: "Dependencia forzada", program_id: program.body.id, credits: 3, hours_per_week: 2 });
    expect(subject.status).toBe(201);

    await request(app)
      .delete(`/api/catalogs/programs/${program.body.id}/permanent`)
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
    await request(app)
      .delete(`/api/catalogs/programs/${program.body.id}/permanent?force=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const subjects = await request(app).get("/api/catalogs/subjects").set("Authorization", `Bearer ${token}`);
    expect(subjects.body.records.some((item: any) => item.id === subject.body.id)).toBe(false);
  });

  it("previews and applies an Excel student import", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([{
      "Matrícula": "TEST-IMP-01",
      "Nombre(s)": "Marina",
      "Apellido paterno": "Importada",
      "Programa": "Bachillerato General",
      "Turno": "Matutino",
      "Grupo": "1A",
      "Ciclo": "2026-2027",
      "Periodo": "Primer parcial",
      "Estatus": "Activo"
    }]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Alumnos");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const preview = await request(app)
      .post("/api/students/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "alumnos.xlsx");
    expect(preview.status).toBe(200);
    expect(preview.body.summary.valid).toBe(1);

    const applied = await request(app)
      .post("/api/students/import/apply")
      .set("Authorization", `Bearer ${token}`)
      .send({ previewId: preview.body.previewId, existingMode: "ignore" });
    expect(applied.status).toBe(200);
    expect(applied.body.created).toBe(1);
  });

  it("updates grades and records immutable history", async () => {
    const assignments = await request(app).get("/api/grades/assignments").set("Authorization", `Bearer ${token}`);
    const assignment = assignments.body.find((item: any) => item.evaluation_mode === "criteria");
    const roster = await request(app)
      .get(`/api/grades/assignment/${assignment.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    const student = roster.body.students[0];
    const updated = await request(app)
      .put(`/api/grades/assignment/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grades: [{ enrollmentId: student.enrollment_id, score: 8.8, comments: "Prueba automatizada", reason: "Validación" }] });
    expect(updated.status).toBe(200);

    const refreshed = await request(app)
      .get(`/api/grades/assignment/${assignment.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    const grade = refreshed.body.students.find((item: any) => item.enrollment_id === student.enrollment_id);
    expect(grade.final_score).toBe(8.8);
    const history = await request(app)
      .get(`/api/grades/history/${grade.grade_id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.body[0].old_score).not.toBe(history.body[0].new_score);

    const components = Object.fromEntries(roster.body.criteria.map((criterion: any) => [criterion.id, 9]));
    const weighted = await request(app)
      .put(`/api/grades/assignment/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grades: [{ enrollmentId: student.enrollment_id, components, comments: "Cálculo ponderado", reason: "Prueba de ponderaciones" }] });
    expect(weighted.status).toBe(200);
    const weightedRoster = await request(app)
      .get(`/api/grades/assignment/${assignment.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    const weightedGrade = weightedRoster.body.students.find((item: any) => item.enrollment_id === student.enrollment_id);
    expect(weightedGrade.final_score).toBe(9);
    expect(Object.keys(weightedGrade.components)).toHaveLength(roster.body.criteria.length);
  });

  it("previews and applies a grade import with update mode", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([{
      "Matrícula": "AN26002",
      "Nombre del alumno": "Diego Martínez Cruz",
      "Programa de estudios": "Bachillerato General",
      "Turno": "Matutino",
      "Grupo": "1A",
      "Materia": "MAT-101",
      "Periodo": "Primer parcial",
      "Calificación": 8.4,
      "Observaciones": "Importación validada"
    }]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Calificaciones");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const preview = await request(app)
      .post("/api/grades/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "calificaciones.xlsx");
    expect(preview.status).toBe(200);
    expect(preview.body.summary.valid).toBe(1);
    expect(preview.body.summary.existing).toBe(1);

    const applied = await request(app)
      .post("/api/grades/import/apply")
      .set("Authorization", `Bearer ${token}`)
      .send({ previewId: preview.body.previewId, existingMode: "update" });
    expect(applied.status).toBe(200);
    expect(applied.body.updated).toBe(1);
  });

  it("blocks edits while grade entry is closed", async () => {
    const assignments = await request(app).get("/api/grades/assignments").set("Authorization", `Bearer ${token}`);
    const assignment = assignments.body[0];
    const roster = await request(app)
      .get(`/api/grades/assignment/${assignment.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/grades/assignment/${assignment.id}/toggle-lock`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const blocked = await request(app)
      .put(`/api/grades/assignment/${assignment.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grades: [{ enrollmentId: roster.body.students[0].enrollment_id, score: 7 }] });
    expect(blocked.status).toBe(409);
    await request(app)
      .post(`/api/grades/assignment/${assignment.id}/toggle-lock`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  it("manages roles, users and institutional settings", async () => {
    const role = await request(app)
      .post("/api/users/roles")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tutor de prueba", description: "Rol creado por pruebas" });
    expect(role.status).toBe(201);
    const roleDetail = await request(app)
      .get(`/api/users/roles/${role.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    const permissionId = roleDetail.body.permissions.find((permission: any) => permission.code === "students.view").id;
    await request(app)
      .put(`/api/users/roles/${role.body.id}/permissions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ permissionIds: [permissionId] })
      .expect(200);
    const user = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Usuario de Prueba", email: "usuario.prueba@example.com", password: "Prueba123!", roleId: role.body.id });
    expect(user.status).toBe(201);

    const current = await request(app).get("/api/settings").set("Authorization", `Bearer ${token}`);
    const settings = current.body.settings;
    const updated = await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionName: "Instituto Aula Nova",
        address: settings.address,
        phone: settings.phone,
        email: settings.email,
        directorName: settings.director_name,
        activeCycleId: settings.active_cycle_id,
        defaultScaleId: settings.default_scale_id,
        footerText: "Pie institucional validado",
        primaryColor: settings.primary_color,
        secondaryColor: settings.secondary_color
      });
    expect(updated.status).toBe(200);
    expect(updated.body.footer_text).toBe("Pie institucional validado");
  });

  it("returns analytics and generates a report card PDF", async () => {
    const analytics = await request(app).get("/api/analytics").set("Authorization", `Bearer ${token}`);
    expect(analytics.status).toBe(200);
    expect(analytics.body.summary.students).toBeGreaterThan(0);

    const students = await request(app).get("/api/students?pageSize=1").set("Authorization", `Bearer ${token}`);
    const report = await request(app)
      .get(`/api/reports/report-card.pdf?studentId=${students.body.records[0].id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("application/pdf");
    expect(report.body.length).toBeGreaterThan(1000);
  });

  it("exports student, grade and operational reports", async () => {
    const endpoints = [
      ["/api/students/export/file?format=xlsx", "spreadsheetml"],
      ["/api/students/export/file?format=csv", "text/csv"],
      ["/api/grades/export/file?format=xlsx", "spreadsheetml"],
      ["/api/grades/export/file?format=pdf", "application/pdf"],
      ["/api/reports/data/gradebook?format=xlsx", "spreadsheetml"],
      ["/api/reports/data/teachers?format=pdf", "application/pdf"]
    ];
    for (const [endpoint, contentType] of endpoints) {
      const response = await request(app).get(endpoint).set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain(contentType);
      expect(response.body.length ?? response.text.length).toBeGreaterThan(30);
    }
    const groups = await request(app).get("/api/catalogs/groups").set("Authorization", `Bearer ${token}`);
    const groupWithStudents = groups.body.records.find((group: any) => group.name === "1A");
    const groupReport = await request(app)
      .get(`/api/reports/report-card.pdf?groupId=${groupWithStudents.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(groupReport.status).toBe(200);
    expect(groupReport.body.length).toBeGreaterThan(1000);
  });
});
