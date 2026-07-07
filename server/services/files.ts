import type { Response } from "express";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

export type TabularRow = Record<string, unknown>;

export function parseWorkbook(buffer: Buffer): TabularRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<TabularRow>(workbook.Sheets[sheetName], {
    defval: "",
    raw: false
  });
}

export function sendWorkbook(
  res: Response,
  filename: string,
  sheetName: string,
  rows: TabularRow[]
) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = Object.keys(rows[0] ?? {}).map((key) => ({
    wch: Math.min(42, Math.max(key.length + 2, ...rows.map((row) => String(row[key] ?? "").length + 2)))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    .send(buffer);
}

export function createPdf(res: Response, filename: string, options: PDFKit.PDFDocumentOptions = {}) {
  const doc = new PDFDocument({ size: "LETTER", margin: 42, ...options });
  res.type("application/pdf").setHeader("Content-Disposition", `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

export function pdfTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  widths?: number[]
) {
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidths = widths ?? headers.map(() => available / headers.length);
  const drawRow = (cells: unknown[], header = false) => {
    const rowHeight = 24;
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const y = doc.y;
    let x = doc.page.margins.left;
    cells.forEach((cell, index) => {
      if (header) doc.rect(x, y, columnWidths[index], rowHeight).fill("#102a43");
      else doc.rect(x, y, columnWidths[index], rowHeight).stroke("#d9e2ec");
      doc
        .fillColor(header ? "#ffffff" : "#243b53")
        .font(header ? "Helvetica-Bold" : "Helvetica")
        .fontSize(header ? 8 : 8)
        .text(String(cell ?? ""), x + 5, y + 7, {
          width: columnWidths[index] - 10,
          height: rowHeight - 8,
          ellipsis: true
        });
      x += columnWidths[index];
    });
    doc.y = y + rowHeight;
  };
  drawRow(headers, true);
  rows.forEach((row) => drawRow(row));
}
