// invoiceValidator — arithmetic sanity checks on a structured invoice.
//
// The LLM structurer can misread a digit (8↔3, dropped decimal). We never trust
// the numbers blindly: we re-derive them and check they reconcile. Anything that
// fails routes the invoice to human review (review_status='needs_review') rather
// than being silently accepted.
//
// Checks:
//   • per line:  qty × unit_price ≈ line_total            → line.calc_ok
//   • subtotal:  Σ line_total      ≈ subtotal
//   • total:     subtotal + tax    ≈ total
//
// Money is compared with an absolute + relative tolerance because OCR/þrint
// rounding means exact equality is unrealistic.

const ABS_TOL = Number(process.env.INVOICE_ABS_TOL || 0.02);  // 2 cents
const REL_TOL = Number(process.env.INVOICE_REL_TOL || 0.01);  // 1%

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// a ≈ b within tolerance. If either is missing, the check is "unknown" (not a
// failure) — we can't validate what wasn't extracted.
function close(a, b) {
  if (a === null || b === null) return null;
  const diff = Math.abs(a - b);
  return diff <= ABS_TOL || diff <= Math.abs(b) * REL_TOL;
}

export function validateInvoice(inv) {
  const issues = [];
  const lines = Array.isArray(inv.line_items) ? inv.line_items : [];

  // Per-line: qty × unit_price = line_total
  const checkedLines = lines.map((li, idx) => {
    const qty = num(li.qty);
    const unit = num(li.unit_price);
    const lineTotal = num(li.line_total);
    let calcOk = null;
    if (qty !== null && unit !== null && lineTotal !== null) {
      calcOk = close(qty * unit, lineTotal);
      if (calcOk === false) {
        issues.push(`line ${idx + 1}: qty×price=${(qty * unit).toFixed(2)} ≠ line_total=${lineTotal}`);
      }
    }
    return { ...li, qty, unit_price: unit, line_total: lineTotal, calc_ok: calcOk };
  });

  // Subtotal: Σ line_total = subtotal
  const subtotal = num(inv.subtotal);
  const tax = num(inv.tax);
  const total = num(inv.total);

  const lineSum = checkedLines.reduce(
    (s, li) => (li.line_total !== null ? s + li.line_total : s), 0,
  );
  const sumOk = subtotal !== null && checkedLines.some((l) => l.line_total !== null)
    ? close(lineSum, subtotal)
    : null;
  if (sumOk === false) issues.push(`Σ lines=${lineSum.toFixed(2)} ≠ subtotal=${subtotal}`);

  // Total: subtotal + tax = total
  let totalOk = null;
  if (subtotal !== null && total !== null) {
    totalOk = close(subtotal + (tax ?? 0), total);
    if (totalOk === false) issues.push(`subtotal+tax=${(subtotal + (tax ?? 0)).toFixed(2)} ≠ total=${total}`);
  }

  // Auto-OK only when every performed check passed (no failures, no all-unknown).
  const performed = [sumOk, totalOk, ...checkedLines.map((l) => l.calc_ok)].filter((v) => v !== null);
  const anyFailed = performed.includes(false);
  const autoOk = performed.length > 0 && !anyFailed;

  return {
    ok: autoOk,
    review_status: autoOk ? 'auto_ok' : 'needs_review',
    issues,
    line_items: checkedLines,
    derived: { lineSum, subtotal, tax, total },
    checks: { sumOk, totalOk },
  };
}
