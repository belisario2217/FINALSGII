import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { all, get, run } from "./db.js";

const secret = process.env.JWT_SECRET ?? "local-development-secret-change-me";

export interface AuthUser {
  id: number;
  fullName: string;
  email: string;
  roleId: number;
  roleName: string;
  studentId: number | null;
  permissions: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function signToken(user: AuthUser) {
  return jwt.sign({ sub: user.id }, secret, { expiresIn: "8h" });
}

export function loadUser(userId: number): AuthUser | undefined {
  const user = get<{
    id: number;
    full_name: string;
    email: string;
    role_id: number;
    role_name: string;
    student_id: number | null;
  }>(
    `SELECT u.id, u.full_name, u.email, u.role_id, r.name AS role_name, u.student_id
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.is_active = 1 AND r.is_active = 1`,
    userId
  );
  if (!user) return undefined;
  const permissions = all<{ code: string }>(
    `SELECT p.code FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = ?`,
    user.role_id
  ).map((permission) => permission.code);
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    roleId: user.role_id,
    roleName: user.role_name,
    studentId: user.student_id,
    permissions
  };
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Inicia sesión para continuar." });
  try {
    const payload = jwt.verify(token, secret) as { sub: string };
    const user = loadUser(Number(payload.sub));
    if (!user) return res.status(401).json({ message: "La sesión ya no es válida." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "La sesión expiró o no es válida." });
  }
}

export function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user?.permissions.includes(permission)) {
      return res.status(403).json({ message: "No tienes permiso para realizar esta acción." });
    }
    next();
  };
}

export function logActivity(
  req: AuthenticatedRequest,
  action: string,
  entityType: string,
  entityId?: string | number,
  details?: unknown
) {
  run(
    `INSERT INTO activity_logs(user_id, action, entity_type, entity_id, details_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    req.user?.id ?? null,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(details),
    req.ip ?? null
  );
}
