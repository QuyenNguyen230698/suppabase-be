// Use exceljs (actively maintained) instead of community xlsx (EOL on npm,
// known prototype-pollution / ReDoS CVEs in 0.18.x). API differs — we render
// each sheet as CSV-ish text so downstream RAG behaves identically.
import ExcelJS from 'exceljs';

function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.text) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink) return String(value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}

function rowToCsv(rowValues) {
  // rowValues from exceljs is 1-based; drop index 0.
  return rowValues.slice(1).map((v) => {
    const s = cellToString(v).replace(/\r?\n/g, ' ');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

export async function extract(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sections = [];
  workbook.eachSheet((sheet) => {
    const lines = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const csv = rowToCsv(row.values);
      if (csv.trim()) lines.push(csv);
    });
    if (lines.length) sections.push(`[Sheet: ${sheet.name}]\n${lines.join('\n')}`);
  });
  return sections.join('\n\n');
}
