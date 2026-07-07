import type { NextFunction, Request, RequestHandler, Response } from "express";

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function cleanText(value: unknown, maxLength = 500): string {
  return String(value ?? "").trim().replace(/\0/g, "").slice(0, maxLength);
}

export function optionalText(value: unknown, maxLength = 500): string | null {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}

export function asId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, `${field} no es válido.`);
  return id;
}

export function asNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ApiError(400, `${field} debe ser numérico.`);
  return number;
}

export function booleanInt(value: unknown): number {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

export function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sendCsv(res: Response, filename: string, headers: string[], rows: unknown[][]) {
  const content = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  res
    .type("text/csv")
    .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    .send(`\uFEFF${content}`);
}
