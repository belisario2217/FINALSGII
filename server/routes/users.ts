import { Router } from "express";
import bcrypt from "bcryptjs";
import { logActivity, requirePermission, type AuthenticatedRequest } from "../auth.js";
import { all, get, run, transaction } from "../db.js";
import { ApiError, asId, cleanText, optionalText } from "../utils.js";

export const usersRouter = Router();

usersRouter.get("/", requirePermission("users.manage"), (_req, res) => {
  res.json(all(
    `SELECT u.id, u.full_name, u.email, u.role_id, r.name AS role_name, u.student_id,
     st.student_number, TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) AS student_name,
     u.is_active, u.last_login_at, u.created_at
     FROM users u JOIN roles r ON r.id = u.role_id
     LEFT JOIN students st ON st.id = u.student_id ORDER BY u.full_name`
  ));
});

usersRouter.get("/student-options", requirePermission("users.manage"), (_req, res) => {
  res.json(all(
    `SELECT st.id, st.student_number,
     TRIM(st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.second_last_name, '')) || ' · ' || st.student_number AS name
     FROM students st WHERE st.is_active = 1 ORDER BY st.last_name, st.first_name`
  ));
});

usersRouter.post("/", requirePermission("users.manage"), async (req: AuthenticatedRequest, res) => {
  const fullName = cleanText(req.body.fullName, 180);
  const email = cleanText(req.body.email, 180).toLowerCase();
  const password = String(req.body.password ?? "");
  if (!fullName || !email || password.length < 8) throw new ApiError(400, "Nombre, correo y contraseña de al menos 8 caracteres son obligatorios.");
  const roleId = asId(req.body.roleId, "Rol");
  const role = get<{ name: string }>("SELECT name FROM roles WHERE id = ?", roleId);
  if (!role) throw new ApiError(400, "El rol seleccionado no existe.");
  const studentId = role.name === "Alumno" ? asId(req.body.studentId, "Alumno vinculado") : null;
  const result = run(
    "INSERT INTO users(full_name, email, password_hash, role_id, student_id) VALUES (?, ?, ?, ?, ?)",
    fullName,
    email,
    await bcrypt.hash(password, 12),
    roleId,
    studentId
  );
  logActivity(req, "create", "users", Number(result.lastInsertRowid), { email });
  res.status(201).json({ id: Number(result.lastInsertRowid), fullName, email });
});

usersRouter.patch("/:id", requirePermission("users.manage"), async (req: AuthenticatedRequest, res) => {
  const id = asId(req.params.id, "Usuario");
  const current = get<{ id: number; role_id: number; student_id: number | null; is_active: number }>("SELECT id, role_id, student_id, is_active FROM users WHERE id = ?", id);
  if (!current) throw new ApiError(404, "No se encontró el usuario.");
  if (id === req.user!.id && req.body.isActive === false) throw new ApiError(400, "No puedes desactivar tu propia cuenta.");
  const passwordHash = req.body.password ? await bcrypt.hash(String(req.body.password), 12) : null;
  const roleId = req.body.roleId ? asId(req.body.roleId, "Rol") : current.role_id;
  const role = get<{ name: string }>("SELECT name FROM roles WHERE id = ?", roleId);
  if (!role) throw new ApiError(400, "El rol seleccionado no existe.");
  const studentId = role.name === "Alumno" ? asId(req.body.studentId ?? current.student_id, "Alumno vinculado") : null;
  run(
    `UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email),
     role_id = COALESCE(?, role_id), is_active = COALESCE(?, is_active),
     password_hash = COALESCE(?, password_hash), student_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    req.body.fullName ? cleanText(req.body.fullName, 180) : null,
    req.body.email ? cleanText(req.body.email, 180).toLowerCase() : null,
    roleId,
    req.body.isActive === undefined ? null : req.body.isActive ? 1 : 0,
    passwordHash,
    studentId,
    id
  );
  logActivity(req, "update", "users", id, { ...req.body, password: req.body.password ? "[updated]" : undefined });
  res.json({ message: "Usuario actualizado." });
});

usersRouter.get("/roles/list", requirePermission("users.manage"), (_req, res) => {
  res.json(all(
    `SELECT r.*, COUNT(rp.permission_id) AS permission_count
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id ORDER BY r.name`
  ));
});

usersRouter.get("/roles/:id", requirePermission("roles.manage"), (req, res) => {
  const id = asId(req.params.id, "Rol");
  const role = get("SELECT * FROM roles WHERE id = ?", id);
  if (!role) throw new ApiError(404, "No se encontró el rol.");
  const permissions = all(
    `SELECT p.*, CASE WHEN rp.role_id IS NULL THEN 0 ELSE 1 END AS enabled
     FROM permissions p LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = ?
     ORDER BY p.module, p.name`,
    id
  );
  res.json({ role, permissions });
});

usersRouter.post("/roles", requirePermission("roles.manage"), (req: AuthenticatedRequest, res) => {
  const name = cleanText(req.body.name, 100);
  if (!name) throw new ApiError(400, "El nombre del rol es obligatorio.");
  const result = run("INSERT INTO roles(name, description) VALUES (?, ?)", name, optionalText(req.body.description, 300));
  logActivity(req, "create", "roles", Number(result.lastInsertRowid), { name });
  res.status(201).json({ id: Number(result.lastInsertRowid), name });
});

usersRouter.put("/roles/:id/permissions", requirePermission("roles.manage"), (req: AuthenticatedRequest, res) => {
  const roleId = asId(req.params.id, "Rol");
  const permissionIds = Array.isArray(req.body.permissionIds)
    ? req.body.permissionIds.map((item: unknown) => asId(item, "Permiso"))
    : [];
  transaction(() => {
    run("DELETE FROM role_permissions WHERE role_id = ?", roleId);
    permissionIds.forEach((permissionId: number) =>
      run("INSERT INTO role_permissions(role_id, permission_id) VALUES (?, ?)", roleId, permissionId)
    );
  });
  logActivity(req, "update-permissions", "roles", roleId, { permissionIds });
  res.json({ message: "Permisos actualizados." });
});
