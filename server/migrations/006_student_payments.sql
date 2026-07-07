ALTER TABLE academic_plans ADD COLUMN tuition_amount REAL NOT NULL DEFAULT 0;

CREATE TABLE student_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES academic_plans(id) ON DELETE SET NULL,
  folio TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL CHECK(amount > 0),
  paid_at TEXT NOT NULL,
  payment_method TEXT,
  concept TEXT NOT NULL DEFAULT 'Colegiatura',
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_student_payments_student ON student_payments(student_id, paid_at);
CREATE INDEX idx_student_payments_plan ON student_payments(plan_id, paid_at);
CREATE INDEX idx_student_payments_month ON student_payments(paid_at);

INSERT OR IGNORE INTO permissions(code, name, module) VALUES
  ('payments.view', 'Consultar cobros', 'payments'),
  ('payments.manage', 'Administrar cobros', 'payments'),
  ('payments.export', 'Exportar estados de cuenta', 'payments');

INSERT OR IGNORE INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('Administrador', 'Coordinador academico', 'Coordinador acadÃ©mico')
  AND p.code IN ('payments.view', 'payments.manage', 'payments.export');
