// Stamps condition_date (util/date-grain.ts owns compares). Precision always
// travels with the returned ISO — no path can stamp a date without one.

const MONTH_TOKEN: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Longest tokens first so 'september' wins over 'sep' (else the day regex sees leftover 'tember').
const MONTH_TOKEN_RX = new RegExp(
  `\\b(${Object.keys(MONTH_TOKEN).sort((a, b) => b.length - a.length).join('|')})\\b`,
);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function parseMonthToken(s: string): number | null {
  if (!s) return null;
  return MONTH_TOKEN[s.trim().toLowerCase()] ?? null;
}

// Date.UTC(y, m, 0) = day 0 of the NEXT month = leap-correct month end.
export function monthEndIso(y: number, m: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad2(m)}-${pad2(last)}`;
}

// Year precision pads to the START, not the end (doctrine convention).
export function yearAnchorIso(y: number): string {
  return `${y}-01-01`;
}

export function inferYear(month: number, day: number, endDate: string | null, now: Date = new Date()): number {
  const nowYear = now.getUTCFullYear();
  if (endDate) {
    const m = /^(\d{4})-/.exec(endDate);
    if (m) {
      const y = parseInt(m[1]!, 10);
      if (y >= nowYear - 1 && y <= nowYear + 5) return y;
    }
  }
  const candidateMs = Date.UTC(nowYear, month - 1, day);
  const cutoffMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return candidateMs >= cutoffMs ? nowYear : nowYear + 1;
}

function endDateYear(endDate: string | null | undefined): number | null {
  if (!endDate) return null;
  const d = new Date(endDate);
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear();
}

const MONTH_DAY_RX = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i;

export type ConditionDateStampSpec =
  | { kind: 'monthDay'; text: string; endDate: string | null; now?: Date }
  // pad 'start' = month-start anchor (precision 'month'); 'end' = real
  // end-of-month deadline (precision 'day'); 'end-month' = month-end day at
  // MONTH precision, the canonical month-grain-deadline representation.
  | { kind: 'monthToken'; mon: string; year?: number; endDate?: string | null; pad: 'start' | 'end' | 'end-month' }
  | { kind: 'year'; year: number }
  | { kind: 'phrase'; text: string; endDate: string | null; now?: Date };

export function stampConditionDate(
  spec: ConditionDateStampSpec,
): { iso: string; precision: 'day' | 'month' | 'year' } | null {
  switch (spec.kind) {
    case 'monthDay': {
      const cleaned = spec.text.trim().replace(/[?.\s]+$/, '');
      const m = MONTH_DAY_RX.exec(cleaned);
      if (!m) return null;
      const month = parseMonthToken(m[1]!);
      if (month == null) return null;
      const day = parseInt(m[2]!, 10);
      const year = m[3] ? parseInt(m[3], 10) : inferYear(month, day, spec.endDate, spec.now);
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day < 1 || day > last) return null;
      return { iso: `${year}-${pad2(month)}-${pad2(day)}`, precision: 'day' };
    }

    case 'monthToken': {
      const month = parseMonthToken(spec.mon);
      if (month == null) return null;
      const year = spec.year ?? endDateYear(spec.endDate);
      if (year == null) return null;
      if (spec.pad === 'start') {
        return { iso: `${year}-${pad2(month)}-01`, precision: 'month' };
      }
      if (spec.pad === 'end-month') {
        return { iso: monthEndIso(year, month), precision: 'month' };
      }
      return { iso: monthEndIso(year, month), precision: 'day' };
    }

    case 'year':
      return { iso: yearAnchorIso(spec.year), precision: 'year' };

    case 'phrase': {
      const txt = spec.text.toLowerCase();
      const now = spec.now ?? new Date();
      const moM = MONTH_TOKEN_RX.exec(txt);
      const yrM = /\b(20\d{2})\b/.exec(txt);
      const month = moM ? parseMonthToken(moM[1]!) : null;
      if (month == null) {
        return yrM ? { iso: yearAnchorIso(parseInt(yrM[1]!, 10)), precision: 'year' } : null;
      }
      const dayM = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(txt);
      if (dayM) {
        const day = parseInt(dayM[1]!, 10);
        const year = yrM ? parseInt(yrM[1]!, 10) : inferYear(month, day, spec.endDate, now);
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
        // A day token past the month end falls through to month precision
        // rather than emitting an invalid ISO date.
        if (day >= 1 && day <= last) {
          return { iso: `${year}-${pad2(month)}-${pad2(day)}`, precision: 'day' };
        }
      }
      const candidateDay = new Date(Date.UTC(now.getUTCFullYear(), month, 0)).getUTCDate();
      const year = yrM ? parseInt(yrM[1]!, 10) : inferYear(month, candidateDay, spec.endDate, now);
      return { iso: monthEndIso(year, month), precision: 'month' };
    }
  }
}
