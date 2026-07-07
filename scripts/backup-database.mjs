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
  grades: count("grades"),
  users: count("users"),
  plans: count("academic_plans")
}));
backup.close();
