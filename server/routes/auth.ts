import { Router } from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import { get, run } from "../db.js";
import { authenticate, loadUser, signToken, type AuthenticatedRequest } from "../auth.js";
import { cleanText } from "../utils.js";

export const authRouter = Router();

authRouter.post(
  "/login",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    const email = cleanText(req.body.email, 180).toLowerCase();
    const password = String(req.body.password ?? "");
    const account = get<{ id: number; password_hash: string; is_active: number }>(
      "SELECT id, password_hash, is_active FROM users WHERE email = ?",
      email
    );
    if (!account || !account.is_active || !(await bcrypt.compare(password, account.password_hash))) {
      return res.status(401).json({ message: "Correo o contraseña incorrectos." });
    }
    const user = loadUser(account.id)!;
    run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", account.id);
    return res.json({ token: signToken(user), user });
  }
);

authRouter.get("/me", authenticate, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});
