import fs from "node:fs";
import path from "node:path";

const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "data/school.db");
for (const suffix of ["", "-shm", "-wal"]) {
  const file = `${databasePath}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file);
}

await import("./db.js");
console.log(`Base de datos recreada en ${databasePath}`);
