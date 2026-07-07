import { Router } from "express";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { ApiError, asId, asNumber, cleanText, optionalText } from "../utils.js";

export const plansRouter = Router();

type NormalizedSubject = {
  subjectCode: string;
  subjectName: string;
  subjectType: "mandatory" | "elective";
  credits: number;
  recommendedPeriod: number;
  hoursPerWeek: number;
};

function planSelect(where = "1 = 1") {
  return `SELECT ap.*, p.name AS program_name, l.name AS level_name,
    COUNT(ps.id) AS subject_count, COALESCE(SUM(ps.credits), 0) AS total_credits,
    COALESCE(SUM(CASE WHEN ps.subject_type = 'mandatory' THEN ps.credits ELSE 0 END), 0) AS mandatory_credits,
    COALESCE(SUM(CASE WHEN ps.subject_type = 'elective' THEN ps.credits ELSE 0 END), 0) AS elective_credits
    FROM academic_plans ap
    JOIN programs p ON p.id = ap.program_id
    LEFT JOIN academic_levels l ON l.id = p.level_id
    LEFT JOIN plan_subjects ps ON ps.plan_id = ap.id
    WHERE ${where}
    GROUP BY ap.id`;
}

plansRouter.get("/", requirePermission("catalogs.view"), (_req, res) => {
  res.json(all(`${planSelect()} ORDER BY ap.is_active DESC, ap.id DESC`));
});

plansRouter.get("/:id", requirePermission("catalogs.view"), (req, res) => {
  const id = asId(req.params.id, "Plan académico");
  const plan = get(`${planSelect("ap.id = ?")}`, id);
  if (!plan) throw new ApiError(404, "No se encontró el plan académico.");
  const subjects = all(
    `SELECT ps.id, ps.subject_id, s.code, s.name, ps.subject_type, ps.credits,
     ps.recommended_period, s.hours_per_week
     FROM plan_subjects ps JOIN subjects s ON s.id = ps.subject_id
     WHERE ps.plan_id = ? ORDER BY ps.recommended_period, s.name`,
    id
  );
  res.json({ plan, subjects });
});

plansRouter.post("/", requirePermission("catalogs.manage"), (req: AuthenticatedRequest, res) => {
  const programId = asId(req.body.programId, "Programa");
  const code = cleanText(req.body.code, 60).toUpperCase();
  const name = cleanText(req.body.name, 180);
  const version = cleanText(req.body.version, 60);
  const tuitionAmount = Math.max(0, asNumber(req.body.tuitionAmount || 0, "Colegiatura"));
  const subjects = Array.isArray(req.body.subjects) ? req.body.subjects : [];
  if (!code || !name || !version) throw new ApiError(400, "Clave, nombre y versión son obligatorios.");
  if (!subjects.length) throw new ApiError(400, "Agrega al menos una asignatura al plan.");

  const normalized: NormalizedSubject[] = subjects.map((item: any, index: number) => {
    const subjectCode = cleanText(item.code, 60).toUpperCase();
    const subjectName = cleanText(item.name, 180);
    const subjectType = item.subjectType === "elective" ? "elective" : "mandatory";
    const credits = asNumber(item.credits, `Créditos de la asignatura ${index + 1}`);
    const recommendedPeriod = Math.max(1, Math.trunc(asNumber(item.recommendedPeriod || 1, "Periodo sugerido")));
    const hoursPerWeek = Math.max(0, Math.trunc(Number(item.hoursPerWeek || 0)));
    if (!subjectCode || !subjectName || credits <= 0) {
      throw new ApiError(400, `Completa clave, nombre y créditos de la asignatura ${index + 1}.`);
    }
    return { subjectCode, subjectName, subjectType, credits, recommendedPeriod, hoursPerWeek };
  });
  if (new Set(normalized.map((item) => item.subjectCode)).size !== normalized.length) {
    throw new ApiError(400, "No repitas claves de asignatura dentro del plan.");
  }

  const planId = transaction(() => {
    const inserted = run(
      `INSERT INTO academic_plans(program_id, code, name, version, description, tuition_amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      programId,
      code,
      name,
      version,
      optionalText(req.body.description, 1000),
      tuitionAmount
    );
    const id = Number(inserted.lastInsertRowid);
    normalized.forEach((item) => {
      run(
        `INSERT OR IGNORE INTO subjects(code, name, program_id, credits, hours_per_week)
         VALUES (?, ?, ?, ?, ?)`,
        item.subjectCode,
        item.subjectName,
        programId,
        item.credits,
        item.hoursPerWeek
      );
      const subject = get<{ id: number }>(
        "SELECT id FROM subjects WHERE code = ? AND program_id = ?",
        item.subjectCode,
        programId
      )!;
      run(
        `INSERT INTO plan_subjects(plan_id, subject_id, subject_type, credits, recommended_period)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        subject.id,
        item.subjectType,
        item.credits,
        item.recommendedPeriod
      );
    });
    if (req.body.assignExisting !== false) {
      run("UPDATE enrollments SET plan_id = ? WHERE program_id = ? AND is_active = 1", id, programId);
    }
    return id;
  });
  logActivity(req, "create", "academic_plans", planId, { code, subjectCount: normalized.length, tuitionAmount });
  res.status(201).json(get(`${planSelect("ap.id = ?")}`, planId));
});

plansRouter.put("/:id", requirePermission("catalogs.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Plan académico");
  if (!get("SELECT id FROM academic_plans WHERE id = ?", id)) throw new ApiError(404, "No se encontró el plan académico.");
  const programId = asId(req.body.programId, "Programa");
  const code = cleanText(req.body.code, 60).toUpperCase();
  const name = cleanText(req.body.name, 180);
  const version = cleanText(req.body.version, 60);
  const tuitionAmount = Math.max(0, asNumber(req.body.tuitionAmount || 0, "Colegiatura"));
  const subjects = Array.isArray(req.body.subjects) ? req.body.subjects : [];
  if (!code || !name || !version) throw new ApiError(400, "Clave, nombre y versión son obligatorios.");
  if (!subjects.length) throw new ApiError(400, "Agrega al menos una asignatura al plan.");
  const normalized: NormalizedSubject[] = subjects.map((item: any, index: number) => {
    const subjectCode = cleanText(item.code, 60).toUpperCase();
    const subjectName = cleanText(item.name, 180);
    const subjectType = item.subjectType === "elective" ? "elective" : "mandatory";
    const credits = asNumber(item.credits, `Créditos de la asignatura ${index + 1}`);
    const recommendedPeriod = Math.max(1, Math.trunc(asNumber(item.recommendedPeriod || 1, "Periodo sugerido")));
    const hoursPerWeek = Math.max(0, Math.trunc(Number(item.hoursPerWeek || 0)));
    if (!subjectCode || !subjectName || credits <= 0) {
      throw new ApiError(400, `Completa clave, nombre y créditos de la asignatura ${index + 1}.`);
    }
    return { subjectCode, subjectName, subjectType, credits, recommendedPeriod, hoursPerWeek };
  });
  if (new Set(normalized.map((item) => item.subjectCode)).size !== normalized.length) {
    throw new ApiError(400, "No repitas claves de asignatura dentro del plan.");
  }

  transaction(() => {
    run(
      `UPDATE academic_plans SET program_id = ?, code = ?, name = ?, version = ?, description = ?, tuition_amount = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      programId,
      code,
      name,
      version,
      optionalText(req.body.description, 1000),
      tuitionAmount,
      id
    );
    run("DELETE FROM plan_subjects WHERE plan_id = ?", id);
    normalized.forEach((item) => {
      run(
        `INSERT OR IGNORE INTO subjects(code, name, program_id, credits, hours_per_week)
         VALUES (?, ?, ?, ?, ?)`,
        item.subjectCode,
        item.subjectName,
        programId,
        item.credits,
        item.hoursPerWeek
      );
      const subject = get<{ id: number }>(
        "SELECT id FROM subjects WHERE code = ? AND program_id = ?",
        item.subjectCode,
        programId
      )!;
      run(
        "UPDATE subjects SET name = ?, credits = ?, hours_per_week = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        item.subjectName,
        item.credits,
        item.hoursPerWeek,
        subject.id
      );
      run(
        `INSERT INTO plan_subjects(plan_id, subject_id, subject_type, credits, recommended_period)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        subject.id,
        item.subjectType,
        item.credits,
        item.recommendedPeriod
      );
    });
    if (req.body.assignExisting === true) {
      run("UPDATE enrollments SET plan_id = ? WHERE program_id = ? AND is_active = 1", id, programId);
    }
  });
  const updated = get(`${planSelect("ap.id = ?")}`, id);
  logActivity(req, "update", "academic_plans", id, { code, subjectCount: normalized.length, tuitionAmount });
  res.json(updated);
});

plansRouter.post("/:id/toggle", requirePermission("catalogs.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Plan académico");
  run(
    `UPDATE academic_plans SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    id
  );
  const plan = get(`${planSelect("ap.id = ?")}`, id);
  if (!plan) throw new ApiError(404, "No se encontró el plan académico.");
  logActivity(req, "toggle", "academic_plans", id, plan);
  res.json(plan);
});

plansRouter.delete("/:id/permanent", requirePermission("catalogs.manage"), (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Plan académico");
  const plan = get("SELECT * FROM academic_plans WHERE id = ?", id);
  if (!plan) throw new ApiError(404, "El plan académico ya no existe.");
  transaction(() => {
    run("UPDATE enrollments SET plan_id = NULL WHERE plan_id = ?", id);
    run("DELETE FROM academic_plans WHERE id = ?", id);
  });
  logActivity(req, "permanent-delete", "academic_plans", id, plan);
  res.status(204).end();
});
