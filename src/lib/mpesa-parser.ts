// Robust M-Pesa statement parser.
// Strategy: use PDF.js to extract positioned text items, group them into rows
// by y-coordinate, then assemble transactions starting at any line whose first
// token is a 10-char receipt number. Subsequent lines without a receipt are
// merged into the prior transaction (handles wrapped Details cells).

export interface MpesaTransaction {
  receiptNo: string;
  completionTime: string; // YYYY-MM-DD HH:MM:SS
  details: string;
  status: string;
  paidIn: number; // 0 if none
  withdrawn: number; // 0 if none (stored as positive magnitude)
  balance: number;
  direction: "credit" | "debit";
  hidden?: boolean; // OD Loan Repayment / Overdraft
}

export interface ParseResult {
  transactions: MpesaTransaction[]; // visible only
  hiddenTransactions: MpesaTransaction[];
  allCount: number;
  visibleCount: number;
  hiddenCount: number;
  totals: { paidIn: number; withdrawn: number };
}

const RECEIPT_RE = /^[A-Z0-9]{10}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/;
const NUMBER_RE = /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;

function toNum(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function isHidden(details: string): boolean {
  const d = details.toLowerCase();
  // Fuliza-related transactions should remain visible.
  if (d.includes("fuliza")) return false;
  return (
    d.includes("od loan repayment") ||
    d.includes("overdraft") ||
    d.includes("m-pesa overdraw")
  );
}

function classify(details: string, paidIn: number, withdrawn: number): "credit" | "debit" {
  if (paidIn > 0 && withdrawn === 0) return "credit";
  if (withdrawn > 0 && paidIn === 0) return "debit";
  const d = details.toLowerCase();
  if (/(salary|funds received|received from|deposit|reversal|receive international)/.test(d)) {
    return "credit";
  }
  return "debit";
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
}

// Group items into visual lines by y coordinate (with tolerance).
function groupIntoLines(items: PositionedItem[]): PositionedItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PositionedItem[][] = [];
  const TOL = 3;
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= TOL) {
      last.push(it);
    } else {
      lines.push([it]);
    }
  }
  for (const ln of lines) ln.sort((a, b) => a.x - b.x);
  return lines;
}

// Assemble a transaction record from a group of lines belonging to it.
function buildTxn(lineItems: PositionedItem[][]): MpesaTransaction | null {
  // Flatten into ordered tokens (line by line)
  const flat: PositionedItem[] = [];
  for (const ln of lineItems) flat.push(...ln);
  if (flat.length === 0) return null;

  const tokens = flat.map((t) => t.str.trim()).filter(Boolean);

  // First token must be receipt
  const receiptNo = tokens[0];
  if (!RECEIPT_RE.test(receiptNo)) return null;

  // Find datetime: scan for "YYYY-MM-DD" then combine with next "HH:MM:SS"
  let completionTime = "";
  let dtIdx = -1;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[i]) && /^\d{2}:\d{2}:\d{2}$/.test(tokens[i + 1])) {
      completionTime = `${tokens[i]} ${tokens[i + 1]}`;
      dtIdx = i;
      break;
    }
    if (DATETIME_RE.test(tokens[i])) {
      completionTime = tokens[i];
      dtIdx = i;
      break;
    }
  }
  if (!completionTime) return null;

  // Find "Completed"/"Failed"/"Pending" status token from the right
  let statusIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^(Completed|Failed|Pending|Cancelled)$/i.test(tokens[i])) {
      statusIdx = i;
      break;
    }
  }
  const status = statusIdx >= 0 ? tokens[statusIdx] : "Completed";

  // Collect numeric tokens after status (PaidIn, Withdrawn, Balance)
  const nums: string[] = [];
  const startNumScan = statusIdx >= 0 ? statusIdx + 1 : -1;
  if (startNumScan > 0) {
    for (let i = startNumScan; i < tokens.length; i++) {
      if (NUMBER_RE.test(tokens[i])) nums.push(tokens[i]);
    }
  } else {
    // fallback: take trailing numerics
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (NUMBER_RE.test(tokens[i])) nums.unshift(tokens[i]);
      else break;
    }
  }

  let paidIn = 0;
  let withdrawn = 0;
  let balance = 0;
  if (nums.length >= 3) {
    paidIn = toNum(nums[0]);
    withdrawn = Math.abs(toNum(nums[1]));
    balance = toNum(nums[nums.length - 1]);
  } else if (nums.length === 2) {
    // One of paidIn/withdrawn is blank
    const a = toNum(nums[0]);
    balance = toNum(nums[1]);
    if (a < 0) withdrawn = Math.abs(a);
    else paidIn = a;
  } else if (nums.length === 1) {
    balance = toNum(nums[0]);
  }

  // Details: tokens between dt end and statusIdx
  const detailsStart = dtIdx + (DATETIME_RE.test(tokens[dtIdx]) ? 1 : 2);
  const detailsEnd = statusIdx >= 0 ? statusIdx : tokens.length;
  const details = tokens.slice(detailsStart, detailsEnd).join(" ").replace(/\s+/g, " ").trim();

  const direction = classify(details, paidIn, withdrawn);
  const txn: MpesaTransaction = {
    receiptNo,
    completionTime,
    details,
    status,
    paidIn,
    withdrawn,
    balance,
    direction,
    hidden: isHidden(details),
  };
  return txn;
}

export async function parseMpesaPdf(file: File): Promise<ParseResult> {
  // Configure pdf.js worker (Vite friendly).
  const pdfjs: typeof import("pdfjs-dist") = await import("pdfjs-dist");
  const workerSrc = (
    (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as { default: string }
  ).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;

  const allItems: PositionedItem[] = [];
  const pageOffsets: number[] = [];
  let yOffset = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    pageOffsets.push(yOffset);
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      const x = item.transform[4];
      const y = item.transform[5];
      // shift y per page so later pages sort below earlier ones
      allItems.push({ str: item.str, x, y: y - yOffset });
    }
    yOffset += viewport.height + 1000;
  }

  const lines = groupIntoLines(allItems);

  // Find the start of the detailed table (after the header "Receipt No.")
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].map((t) => t.str).join(" ");
    if (/Receipt\s*No\.?/i.test(text) && /Completion/i.test(text)) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx < 0) startIdx = 0;

  // Walk lines; a new transaction starts when first non-empty token matches RECEIPT_RE.
  const txGroups: PositionedItem[][][] = [];
  let current: PositionedItem[][] | null = null;
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i];
    const firstTok = ln.find((t) => t.str.trim())?.str.trim() ?? "";

    // Stop if we hit footer/disclaimer/page-header lines
    const lineText = ln.map((t) => t.str).join(" ");
    if (
      /Disclaimer|Statement Verification Code|Page \d+ of \d+|For self-help|safaricom\.co\.ke/i.test(
        lineText,
      )
    ) {
      // skip footer/header lines but keep parsing — table may continue on next page
      continue;
    }
    // re-encountered table header on page 2
    if (/Receipt\s*No\.?/i.test(lineText) && /Completion/i.test(lineText)) {
      continue;
    }

    if (RECEIPT_RE.test(firstTok)) {
      if (current) txGroups.push(current);
      current = [ln];
    } else if (current) {
      current.push(ln);
    }
  }
  if (current) txGroups.push(current);

  const all: MpesaTransaction[] = [];
  for (const g of txGroups) {
    const t = buildTxn(g);
    if (t && t.receiptNo && t.completionTime) all.push(t);
  }

  // Dedupe by composite key
  const seen = new Set<string>();
  const deduped: MpesaTransaction[] = [];
  for (const t of all) {
    const key = `${t.receiptNo}|${t.completionTime}|${t.details}|${t.paidIn}|${t.withdrawn}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(t);
    }
  }

  const visible = deduped.filter((t) => !t.hidden);
  const hidden = deduped.filter((t) => t.hidden);
  const totals = visible.reduce(
    (acc, t) => {
      acc.paidIn += t.paidIn;
      acc.withdrawn += t.withdrawn;
      return acc;
    },
    { paidIn: 0, withdrawn: 0 },
  );

  return {
    transactions: visible,
    hiddenTransactions: hidden,
    allCount: deduped.length,
    visibleCount: visible.length,
    hiddenCount: hidden.length,
    totals,
  };
}
