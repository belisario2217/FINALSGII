import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import multer from "multer";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, databasePath, db, get, restorePath, run } from "../db.js";
import { ApiError, cleanText, optionalText } from "../utils.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uploadsDir = process.env.UPLOADS_PATH
  ? path.resolve(process.env.UPLOADS_PATH)
  : path.join(projectRoot, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    if (allowed) callback(null, true);
    else callback(new ApiError(400, "El logo debe ser PNG, JPG o WebP."));
  }
});
const databaseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

export const settingsRouter = Router();

settingsRouter.get("/", requirePermission("dashboard.view"), (_req, res) => {
  res.json({
    settings: get(
      `SELECT i.*, c.name AS active_cycle_name, s.name AS default_scale_name
       FROM institution_settings i LEFT JOIN school_cycles c ON c.id = i.active_cycle_id
       LEFT JOIN grading_scales s ON s.id = i.default_scale_id WHERE i.id = 1`
    ),
    cycles: all("SELECT id, name FROM school_cycles WHERE is_active = 1 ORDER BY start_date DESC"),
    scales: all("SELECT id, name FROM grading_scales WHERE is_active = 1 ORDER BY name")
  });
});

settingsRouter.patch("/", requirePermission("settings.manage"), (req: AuthenticatedRequest, res) => {
  const body = req.body;
  const name = cleanText(body.institutionName, 200);
  if (!name) throw new ApiError(400, "El nombre de la institución es obligatorio.");
  run(
    `UPDATE institution_settings SET institution_name = ?, address = ?, phone = ?, email = ?,
     director_name = ?, active_cycle_id = ?, default_scale_id = ?, footer_text = ?,
     primary_color = ?, secondary_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
    name,
    optionalText(body.address, 300),
    optionalText(body.phone, 50),
    optionalText(body.email, 180),
    optionalText(body.directorName, 180),
    body.activeCycleId ? Number(body.activeCycleId) : null,
    body.defaultScaleId ? Number(body.defaultScaleId) : null,
    optionalText(body.footerText, 500),
    cleanText(body.primaryColor, 20) || "#102a43",
    cleanText(body.secondaryColor, 20) || "#f97360"
  );
  logActivity(req, "update", "institution_settings", 1, body);
  res.json(get("SELECT * FROM institution_settings WHERE id = 1"));
});

settingsRouter.post("/logo", requirePermission("settings.manage"), upload.single("logo"), (req: AuthenticatedRequest, res) => {
  if (!req.file) throw new ApiError(400, "Selecciona un logo.");
  const extension = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
  const filename = `institution-logo-${Date.now()}.${extension}`;
  fs.writeFileSync(path.join(uploadsDir, filename), req.file.buffer);
  const logoPath = `/uploads/${filename}`;
  run("UPDATE institution_settings SET logo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1", logoPath);
  logActivity(req, "upload-logo", "institution_settings", 1, { logoPath });
  res.json({ logoPath });
});

settingsRouter.post(
  "/restore-database",
  requirePermission("settings.manage"),
  databaseUpload.single("database"),
  (req: AuthenticatedRequest, res) => {
    if (req.user?.roleName !== "Administrador") {
      throw new ApiError(403, "Solo un administrador puede restaurar la base de datos.");
    }
    if (!req.file) throw new ApiError(400, "Selecciona un archivo SQLite.");
    if (!req.file.buffer.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) {
      throw new ApiError(400, "El archivo seleccionado no es una base SQLite valida.");
    }

    const validationPath = `${databasePath}.validation-${Date.now()}`;
    try {
      fs.writeFileSync(validationPath, req.file.buffer, { flag: "wx" });
      const candidate = new DatabaseSync(validationPath, { readOnly: true });
      try {
        const check = candidate.prepare("PRAGMA quick_check").get() as Record<string, string>;
        if (!Object.values(check).includes("ok")) {
          throw new ApiError(400, "La base SQLite esta danada.");
        }
        const requiredTables = ["users", "students", "enrollments", "grades", "academic_plans"];
        const tables = candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        const available = new Set(tables.map((table) => table.name));
        if (requiredTables.some((table) => !available.has(table))) {
          throw new ApiError(400, "La base no corresponde a Universidad IFOP.");
        }
        const count = (table: string) => Number((candidate.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
        const summary = {
          students: count("students"),
          grades: count("grades"),
          users: count("users"),
          plans: count("academic_plans")
        };
        candidate.close();
        if (fs.existsSync(restorePath)) fs.rmSync(restorePath);
        fs.renameSync(validationPath, restorePath);
        logActivity(req, "stage-database-restore", "database", undefined, summary);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        res.json({ message: "Respaldo validado. Ejecuta un despliegue manual en Render para aplicarlo.", summary });
      } catch (error) {
        try { candidate.close(); } catch { /* Already closed. */ }
        throw error;
      }
    } finally {
      if (fs.existsSync(validationPath)) fs.rmSync(validationPath);
    }
  }
);

settingsRouter.get("/database-backup", requirePermission("settings.manage"), (req: AuthenticatedRequest, res) => {
  if (req.user?.roleName !== "Administrador") {
    throw new ApiError(403, "Solo un administrador puede descargar la base de datos.");
  }
  if (!fs.existsSync(databasePath)) throw new ApiError(404, "No se encontro la base de datos.");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const date = new Date().toISOString().slice(0, 10);
  logActivity(req, "download-database-backup", "database", undefined, { databasePath });
  res.download(databasePath, `universidad-ifop-respaldo-${date}.db`);
});

settingsRouter.get("/audit", requirePermission("audit.view"), (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(all(
    `SELECT l.*, u.full_name AS user_name FROM activity_logs l
     LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT ?`,
    limit
  ));
});
