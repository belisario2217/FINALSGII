ALTER TABLE users ADD COLUMN student_id INTEGER REFERENCES students(id);

ALTER TABLE subject_assignments ADD COLUMN evaluation_mode TEXT NOT NULL DEFAULT 'partials'
  CHECK(evaluation_mode IN ('partials', 'criteria', 'final'));

ALTER TABLE grades ADD COLUMN partial_1 REAL;
ALTER TABLE grades ADD COLUMN partial_2 REAL;
ALTER TABLE grades ADD COLUMN partial_3 REAL;

CREATE TABLE academic_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plan_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES academic_plans(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('mandatory', 'elective')),
  credits REAL NOT NULL CHECK(credits > 0),
  recommended_period INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plan_id, subject_id)
);

ALTER TABLE enrollments ADD COLUMN plan_id INTEGER REFERENCES academic_plans(id);

CREATE INDEX idx_users_student ON users(student_id);
CREATE INDEX idx_academic_plans_program ON academic_plans(program_id, is_active);
CREATE INDEX idx_plan_subjects_plan ON plan_subjects(plan_id, recommended_period);

INSERT OR IGNORE INTO academic_levels(name, description) VALUES
  ('Licenciatura', 'Educación superior de nivel licenciatura'),
  ('Maestría', 'Estudios de posgrado de nivel maestría'),
  ('Especialidad', 'Programa de especialización profesional');

UPDATE subject_assignments
SET evaluation_mode = 'criteria'
WHERE EXISTS (SELECT 1 FROM assignment_criteria ac WHERE ac.assignment_id = subject_assignments.id);

UPDATE grades
SET partial_1 = final_score, partial_2 = final_score, partial_3 = final_score
WHERE final_score IS NOT NULL;

INSERT OR IGNORE INTO academic_plans(program_id, code, name, version, description)
SELECT id, code || '-PLAN-2026', name || ' - Plan 2026', '2026',
       'Plan inicial generado a partir de las materias existentes'
FROM programs;

INSERT OR IGNORE INTO plan_subjects(plan_id, subject_id, subject_type, credits, recommended_period)
SELECT ap.id, s.id, 'mandatory', CASE WHEN s.credits > 0 THEN s.credits ELSE 1 END, 1
FROM subjects s
JOIN academic_plans ap ON ap.program_id = s.program_id;

UPDATE enrollments
SET plan_id = (
  SELECT ap.id FROM academic_plans ap
  WHERE ap.program_id = enrollments.program_id AND ap.is_active = 1
  ORDER BY ap.id DESC LIMIT 1
)
WHERE plan_id IS NULL;
