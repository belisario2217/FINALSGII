DELETE FROM academic_plans
WHERE code LIKE '%-PLAN-2026'
  AND NOT EXISTS (SELECT 1 FROM plan_subjects ps WHERE ps.plan_id = academic_plans.id)
  AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.plan_id = academic_plans.id);
