import { DatabaseSync } from "node:sqlite";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error("Uso: node scripts/backup-database.mjs <origen> <destino>");
}

const source = new DatabaseSync(sourcePath);
const escapedOutput = outputPath.replaceAll("'", "''");
source.exec(`VACUUM INTO '${escapedOutput}'`);
source.close();

const backup = new DatabaseSync(outputPath, { readOnly: true });
const count = (table) => backup.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
console.log(JSON.stringify({
  students: count("students"),
  enrollments: count("enrollments"),
  grades: count("grades"),
  payments: count("student_payments"),
  users: count("users"),
  plans: count("academic_plans"),
  planSubjects: count("plan_subjects"),
  subjects: count("subjects"),
  groups: count("groups"),
  shifts: count("shifts"),
  cycles: count("school_cycles"),
  periods: count("academic_periods"),
  programs: count("programs")
}));
backup.close();
