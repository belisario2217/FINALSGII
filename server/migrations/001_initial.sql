PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  module TEXT NOT NULL,
  description TEXT
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE academic_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  level_id INTEGER REFERENCES academic_levels(id),
  description TEXT,
  duration_periods INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_time TEXT,
  end_time TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE school_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE academic_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES school_cycles(id),
  name TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  grade_entry_open INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cycle_id, name)
);

CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  cycle_id INTEGER NOT NULL REFERENCES school_cycles(id),
  capacity INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, program_id, shift_id, cycle_id)
);

CREATE TABLE teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  specialty TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE grading_scales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  min_score REAL NOT NULL,
  max_score REAL NOT NULL,
  passing_score REAL NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE student_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#64748b',
  is_terminal INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_number TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  second_last_name TEXT,
  curp TEXT UNIQUE,
  birth_date TEXT,
  email TEXT,
  phone TEXT,
  emergency_contact TEXT,
  address TEXT,
  notes TEXT,
  status_id INTEGER NOT NULL REFERENCES student_statuses(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  cycle_id INTEGER NOT NULL REFERENCES school_cycles(id),
  period_id INTEGER REFERENCES academic_periods(id),
  enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(student_id, cycle_id)
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  credits REAL NOT NULL DEFAULT 0,
  hours_per_week INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, program_id)
);

CREATE TABLE evaluation_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_weight REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subject_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  period_id INTEGER NOT NULL REFERENCES academic_periods(id),
  grading_scale_id INTEGER NOT NULL REFERENCES grading_scales(id),
  grade_entry_locked INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject_id, group_id, period_id)
);

CREATE TABLE assignment_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES subject_assignments(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES evaluation_criteria(id),
  weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 100),
  UNIQUE(assignment_id, criterion_id)
);

CREATE TABLE grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  assignment_id INTEGER NOT NULL REFERENCES subject_assignments(id),
  final_score REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'passed', 'failed')),
  comments TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(enrollment_id, assignment_id)
);

CREATE TABLE grade_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  assignment_criterion_id INTEGER NOT NULL REFERENCES assignment_criteria(id),
  score REAL NOT NULL,
  weighted_score REAL NOT NULL,
  UNIQUE(grade_id, assignment_criterion_id)
);

CREATE TABLE grade_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('previewed', 'applied', 'failed')),
  errors_json TEXT,
  imported_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT
);

CREATE TABLE grade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  old_score REAL,
  new_score REAL,
  old_comments TEXT,
  new_comments TEXT,
  reason TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE report_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  header_text TEXT,
  footer_text TEXT,
  primary_color TEXT NOT NULL DEFAULT '#102a43',
  secondary_color TEXT NOT NULL DEFAULT '#f97360',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE institution_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  institution_name TEXT NOT NULL,
  logo_path TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  director_name TEXT,
  active_cycle_id INTEGER REFERENCES school_cycles(id),
  default_scale_id INTEGER REFERENCES grading_scales(id),
  footer_text TEXT,
  primary_color TEXT NOT NULL DEFAULT '#102a43',
  secondary_color TEXT NOT NULL DEFAULT '#f97360',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_students_name ON students(last_name, first_name);
CREATE INDEX idx_students_status ON students(status_id, is_active);
CREATE INDEX idx_enrollments_filters ON enrollments(program_id, shift_id, group_id, cycle_id);
CREATE INDEX idx_assignments_filters ON subject_assignments(group_id, teacher_id, period_id);
CREATE INDEX idx_grades_assignment ON grades(assignment_id, status);
CREATE INDEX idx_grade_history_grade ON grade_history(grade_id, changed_at);
CREATE INDEX idx_activity_entity ON activity_logs(entity_type, entity_id, created_at);
