import { Router } from "express";
import { requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get } from "../db.js";
import { buildBilling } from "../services/billing.js";
import { ApiError } from "../utils.js";

export const portalRouter = Router();

type PortalSubject = {
  plan_subject_id: number | null;
  subject_id: number;
  code: string;
  name: string;
  subject_type: "mandatory" | "elective";
  credits: number;
  recommended_period: number;
  assignment_id: number | null;
  evaluation_mode: string | null;
  teacher_name: string | null;
  partial_1: number | null;
  partial_2: number | null;
  partial_3: number | null;
  final_score: number | null;
  status: "pending" | "passed" | "failed";
  comments: string | null;
};

function scoreOrNull(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function summarizeSubject(subject: any, gradeRows: any[]): PortalSubject {
  const rows = gradeRows.filter((grade) => grade.subject_id === subject.subject_id);
  const latest = rows.at(-1);
  const partialMode = rows.find((grade) =>
    grade.evaluation_mode === "partials" &&
    (grade.partial_1 != null || grade.partial_2 != null || grade.partial_3 != null)
  );
  const bySequence = (sequence: number) => {
    const match = rows.filter((grade) => grade.period_sequence === sequence && grade.final_score != null).at(-1);
    return scoreOrNull(match?.final_score);
  };
  const partial_1 = scoreOrNull(partialMode?.partial_1) ?? bySequence(1);
  const partial_2 = scoreOrNull(partialMode?.partial_2) ?? bySequence(2);
  const partial_3 = scoreOrNull(partialMode?.partial_3) ?? bySequence(3);
  const completedScores = rows
    .map((grade) => scoreOrNull(grade.final_score))
    .filter((score): score is number => score !== null);
  const final_score = completedScores.length
    ? Number((completedScores.reduce((sum, score) => sum + score, 0) / completedScores.length).toFixed(1))
    : null;
  const passingScore = Math.max(...rows.map((grade) => Number(grade.passing_score ?? 0)), 0);
  const status = final_score == null ? "pending" : final_score >= passingScore ? "passed" : "failed";
  const comments = [...new Set(rows.map((grade) => grade.comments).filter(Boolean))].join(" | ") || null;
  return {
    ...subject,
    assignment_id: latest?.assignment_id ?? null,
    evaluation_mode: latest?.evaluation_mode ?? null,
    teacher_name: latest?.teacher_name ?? null,
    partial_1,
    partial_2,
    partial_3,
    final_score,
    status,
    comments
  };
}

portalRouter.get("/", requirePermission("portal.view"), (req: AuthenticatedRequest, res) => {
  if (!req.user?.studentId) throw new ApiError(403, "Esta cuenta todavía no está vinculada con un alumno.");
  const enrollment = get<any>(
    `SELECT e.id AS enrollment_id, e.plan_id, e.group_id, e.enrolled_at, sc.start_date AS billing_start_date,
     p.duration_periods, pl.tuition_amount, st.id AS student_id, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
     st.email, p.name AS program_name, g.name AS group_name, sh.name AS shift_name,
     sc.name AS cycle_name, ap.name AS current_period, pl.name AS plan_name, pl.code AS plan_code,
     pl.version AS plan_version, l.name AS level_name
     FROM enrollments e
     JOIN students st ON st.id = e.student_id
     JOIN programs p ON p.id = e.program_id
     LEFT JOIN academic_levels l ON l.id = p.level_id
     JOIN groups g ON g.id = e.group_id
     JOIN shifts sh ON sh.id = e.shift_id
     JOIN school_cycles sc ON sc.id = e.cycle_id
     LEFT JOIN academic_periods ap ON ap.id = e.period_id
     LEFT JOIN academic_plans pl ON pl.id = e.plan_id
     WHERE e.student_id = ? AND e.is_active = 1
     ORDER BY e.id DESC LIMIT 1`,
    req.user.studentId
  );
  if (!enrollment) throw new ApiError(404, "No se encontró una inscripción activa para este alumno.");

  const gradeRows = all<any>(
    `SELECT s.id AS subject_id, s.code, s.name, COALESCE(NULLIF(s.credits, 0), 1) AS subject_credits,
     a.id AS assignment_id, a.evaluation_mode, ap.sequence AS period_sequence,
     t.full_name AS teacher_name, gr.partial_1, gr.partial_2, gr.partial_3,
     gr.final_score, gr.status, gr.comments, gs.passing_score
     FROM grades gr
     JOIN subject_assignments a ON a.id = gr.assignment_id
     JOIN subjects s ON s.id = a.subject_id
     JOIN academic_periods ap ON ap.id = a.period_id
     JOIN grading_scales gs ON gs.id = a.grading_scale_id
     LEFT JOIN teachers t ON t.id = a.teacher_id
     WHERE gr.enrollment_id = ?
     ORDER BY s.name, ap.sequence, a.id`,
    enrollment.enrollment_id
  );
  const baseSubjects = enrollment.plan_id ? all<any>(
    `SELECT ps.id AS plan_subject_id, s.id AS subject_id, s.code, s.name,
     ps.subject_type, ps.credits, ps.recommended_period
     FROM plan_subjects ps
     JOIN subjects s ON s.id = ps.subject_id
     WHERE ps.plan_id = ?
     ORDER BY ps.recommended_period, s.name`,
    enrollment.plan_id
  ) : gradeRows.map((grade) => ({
    plan_subject_id: null,
    subject_id: grade.subject_id,
    code: grade.code,
    name: grade.name,
    subject_type: "mandatory",
    credits: grade.subject_credits,
    recommended_period: grade.period_sequence
  })).filter((subject, index, list) => list.findIndex((item) => item.subject_id === subject.subject_id) === index);
  const gradeOnlySubjects = gradeRows
    .filter((grade) => !baseSubjects.some((subject) => subject.subject_id === grade.subject_id))
    .map((grade) => ({
      plan_subject_id: null,
      subject_id: grade.subject_id,
      code: grade.code,
      name: grade.name,
      subject_type: "mandatory",
      credits: grade.subject_credits,
      recommended_period: grade.period_sequence
    }));
  const subjects = [...baseSubjects, ...gradeOnlySubjects]
    .map((subject) => summarizeSubject(subject, gradeRows))
    .sort((left, right) => left.recommended_period - right.recommended_period || left.name.localeCompare(right.name));

  const totalCredits = subjects.reduce((sum, subject) => sum + Number(subject.credits), 0);
  const earnedCredits = subjects
    .filter((subject) => subject.status === "passed")
    .reduce((sum, subject) => sum + Number(subject.credits), 0);
  const graded = subjects.filter((subject) => subject.final_score != null);
  const average = graded.length
    ? graded.reduce((sum, subject) => sum + Number(subject.final_score), 0) / graded.length
    : null;

  res.json({
    student: enrollment,
    progress: {
      totalCredits,
      earnedCredits,
      pendingCredits: Math.max(0, totalCredits - earnedCredits),
      percentage: totalCredits ? Number((earnedCredits / totalCredits * 100).toFixed(1)) : 0,
      average: average == null ? null : Number(average.toFixed(1)),
      completedSubjects: subjects.filter((subject) => subject.status === "passed").length,
      totalSubjects: subjects.length
    },
    billing: buildBilling({
      studentId: enrollment.student_id,
      enrollmentId: enrollment.enrollment_id,
      planId: enrollment.plan_id,
      durationPeriods: enrollment.duration_periods,
      tuitionAmount: enrollment.tuition_amount,
      billingStartDate: enrollment.billing_start_date,
      enrolledAt: enrollment.enrolled_at
    }),
    subjects
  });
});
