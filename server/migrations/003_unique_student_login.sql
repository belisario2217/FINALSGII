CREATE UNIQUE INDEX idx_users_student_unique ON users(student_id) WHERE student_id IS NOT NULL;
