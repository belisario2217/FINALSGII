import { Router } from "express";
import { requirePermission } from "../auth.js";
import { all, get } from "../db.js";

export const analyticsRouter = Router();

analyticsRouter.get("/", requirePermission("analytics.view"), (req, res) => {
  const clauses = ["gr.final_score IS NOT NULL"];
  const params: number[] = [];
  const filters: Array<[string, unknown]> = [
    ["e.program_id", req.query.programId],
    ["e.shift_id", req.query.shiftId],
    ["e.group_id", req.query.groupId],
    ["a.period_id", req.query.periodId],
    ["e.cycle_id", req.query.cycleId]
  ];
  filters.forEach(([column, input]) => {
    if (input) {
      clauses.push(`${column} = ?`);
      params.push(Number(input));
    }
  });
  const where = clauses.join(" AND ");
  const base = `FROM grades gr JOIN enrollments e ON e.id = gr.enrollment_id
    JOIN students st ON st.id = e.student_id JOIN programs p ON p.id = e.program_id
    JOIN shifts sh ON sh.id = e.shift_id JOIN groups g ON g.id = e.group_id
    JOIN subject_assignments a ON a.id = gr.assignment_id JOIN subjects s ON s.id = a.subject_id
    JOIN teachers t ON t.id = a.teacher_id JOIN academic_periods ap ON ap.id = a.period_id
    JOIN grading_scales gs ON gs.id = a.grading_scale_id WHERE ${where}`;

  const summary = get<any>(
    `SELECT ROUND(AVG(gr.final_score), 2) AS average,
     COUNT(DISTINCT e.student_id) AS students,
     SUM(CASE WHEN gr.final_score >= gs.passing_score THEN 1 ELSE 0 END) AS passed,
     SUM(CASE WHEN gr.final_score < gs.passing_score THEN 1 ELSE 0 END) AS failed,
     SUM(CASE WHEN gr.final_score < gs.passing_score + 1 THEN 1 ELSE 0 END) AS at_risk
     ${base}`,
    ...params
  );

  const groupAverages = all(
    `SELECT g.id, g.name, ROUND(AVG(gr.final_score), 2) AS average,
     COUNT(DISTINCT e.student_id) AS students ${base} GROUP BY g.id, g.name ORDER BY average DESC`,
    ...params
  );
  const programAverages = all(
    `SELECT p.id, p.name, ROUND(AVG(gr.final_score), 2) AS average ${base}
     GROUP BY p.id, p.name ORDER BY average DESC`,
    ...params
  );
  const shiftAverages = all(
    `SELECT sh.id, sh.name, ROUND(AVG(gr.final_score), 2) AS average ${base}
     GROUP BY sh.id, sh.name ORDER BY average DESC`,
    ...params
  );
  const subjectAverages = all(
    `SELECT s.id, s.name, ROUND(AVG(gr.final_score), 2) AS average,
     ROUND(100.0 * SUM(CASE WHEN gr.final_score < gs.passing_score THEN 1 ELSE 0 END) / COUNT(*), 1) AS failure_rate
     ${base} GROUP BY s.id, s.name ORDER BY failure_rate DESC, average`,
    ...params
  );
  const ranking = all(
    `SELECT st.id, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS name,
     g.name AS group_name, ROUND(AVG(gr.final_score), 2) AS average
     ${base} GROUP BY st.id, st.student_number, st.first_name, st.last_name, st.second_last_name, g.name
     ORDER BY average DESC LIMIT 10`,
    ...params
  );
  const periodComparison = all(
    `SELECT ap.id, ap.name, ap.sequence, ROUND(AVG(gr.final_score), 2) AS average
     ${base} GROUP BY ap.id, ap.name, ap.sequence ORDER BY ap.sequence`,
    ...params
  );
  const teacherResults = all(
    `SELECT t.id, t.full_name AS name, COUNT(DISTINCT a.group_id) AS groups,
     ROUND(AVG(gr.final_score), 2) AS average ${base}
     GROUP BY t.id, t.full_name ORDER BY average DESC`,
    ...params
  );
  res.json({ summary, groupAverages, programAverages, shiftAverages, subjectAverages, ranking, periodComparison, teacherResults });
});
