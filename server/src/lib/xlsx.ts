import ExcelJS from "exceljs";
import type { Response } from "express";

export type CellValue = string | number | null | undefined;

export interface SheetOptions {
  title?: string;
  subtitle?: string;
  landscape?: boolean;
}

export function createWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BATAWIL HRMS";
  workbook.created = new Date();
  return workbook;
}

export function addDataSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: CellValue[][],
  options: SheetOptions = {},
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name.slice(0, 31), {
    views: [{ rightToLeft: true }],
    pageSetup: {
      paperSize: 9,
      orientation: options.landscape ? "landscape" : "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  let headerRowNumber = 1;
  if (options.title) {
    sheet.mergeCells(1, 1, 1, Math.max(headers.length, 1));
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = options.title;
    titleCell.font = { bold: true, size: 16, color: { argb: "FF14332B" } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 26;
    if (options.subtitle) {
      sheet.mergeCells(2, 1, 2, Math.max(headers.length, 1));
      const subtitleCell = sheet.getCell(2, 1);
      subtitleCell.value = options.subtitle;
      subtitleCell.font = { size: 10, color: { argb: "FF5B6B66" } };
      subtitleCell.alignment = { horizontal: "center" };
      sheet.getRow(2).height = 18;
      headerRowNumber = 3;
    } else {
      headerRowNumber = 2;
    }
    sheet.getRow(headerRowNumber - 1).height = 8;
  }

  const headerRow = sheet.getRow(headerRowNumber);
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E45" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9E2DE" } },
      bottom: { style: "thin", color: { argb: "FFD9E2DE" } },
      left: { style: "thin", color: { argb: "FFD9E2DE" } },
      right: { style: "thin", color: { argb: "FFD9E2DE" } },
    };
  });
  headerRow.height = 28;

  rows.forEach((values) => {
    const row = sheet.addRow(values);
    row.alignment = { horizontal: "right", vertical: "middle" };
    row.font = { size: 10 };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFE8EEEB" } },
        bottom: { style: "thin", color: { argb: "FFE8EEEB" } },
        left: { style: "thin", color: { argb: "FFE8EEEB" } },
        right: { style: "thin", color: { argb: "FFE8EEEB" } },
      };
    });
  });

  headers.forEach((header, index) => {
    const maxContent = rows.reduce((max, row) => {
      const value = row[index];
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
    }, header.length);
    sheet.getColumn(index + 1).width = Math.min(Math.max(maxContent + 4, 10), 32);
  });

  if (options.title) {
    sheet.headerFooter.oddFooter = "&Rنظام BATAWIL للموارد البشرية&Cصفحة &P من &N&Lتاريخ الطباعة: &D";
  }
  sheet.views = [{ rightToLeft: true, state: "frozen", ySplit: headerRowNumber }];

  return sheet;
}

export async function workbookBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

export function sendWorkbook(res: Response, workbook: ExcelJS.Workbook, baseName: string): Promise<void> {
  return workbookBuffer(workbook).then((buffer) => {
    const date = new Date().toISOString().slice(0, 10);
    const fileName = encodeURIComponent(`${baseName}-${date}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
    res.status(200).send(buffer);
  });
}
