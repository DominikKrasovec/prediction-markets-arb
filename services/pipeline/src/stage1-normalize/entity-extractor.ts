import type { ExtractedDate, ExtractedNumber } from '@arb/types';

const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DATE_REGEXES = [
  // "March 31, 2026" / "March 31 2026" / "Mar 31, 2026"
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi,
  // "31 March 2026"
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/gi,
  // "2026-03-31"
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  // "Q1 2026", "Q2 2026"
  /\b(Q[1-4])\s+(\d{4})\b/gi,
  // "end of 2026", "by 2026"
  /\b(?:by|end\s+of|before)\s+(\d{4})\b/gi,
];

const ROLE_KEYWORDS: Record<string, 'deadline' | 'event'> = {
  'by': 'deadline', 'before': 'deadline', 'until': 'deadline',
  'end of': 'deadline', 'deadline': 'deadline',
  'on': 'event', 'during': 'event', 'at': 'event',
};

export function extractDates(text: string, source: 'title' | 'description' | 'end_date'): ExtractedDate[] {
  const results: ExtractedDate[] = [];
  const seen = new Set<string>();

  // Natural language dates: "March 31, 2026"
  for (const match of text.matchAll(DATE_REGEXES[0])) {
    const month = MONTH_MAP[match[1].toLowerCase()];
    if (month === undefined) continue;
    const day = parseInt(match[2]);
    const year = parseInt(match[3]);
    const d = new Date(year, month, day);
    if (isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ raw: match[0], parsed: d, role: inferDateRole(text, match.index ?? 0), source });
  }

  // ISO dates: "2026-03-31"
  for (const match of text.matchAll(DATE_REGEXES[2])) {
    const d = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    if (isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ raw: match[0], parsed: d, role: inferDateRole(text, match.index ?? 0), source });
  }

  // Quarter references: "Q1 2026" → end of quarter
  for (const match of text.matchAll(DATE_REGEXES[3])) {
    const q = parseInt(match[1].charAt(1));
    const year = parseInt(match[2]);
    const month = q * 3 - 1; // Q1→Feb(end of Mar), Q2→May(end of Jun), etc.
    const d = new Date(year, month + 1, 0); // last day of quarter
    const key = d.toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ raw: match[0], parsed: d, role: 'deadline', source });
  }

  return results;
}

function inferDateRole(text: string, matchIndex: number): 'deadline' | 'event' | 'reference' {
  // Look at the 30 chars before the match for role keywords
  const prefix = text.slice(Math.max(0, matchIndex - 30), matchIndex).toLowerCase();
  for (const [keyword, role] of Object.entries(ROLE_KEYWORDS)) {
    if (prefix.includes(keyword)) return role;
  }
  return 'reference';
}

const NUMBER_REGEXES = [
  // "$200,000" / "$1.5M" / "$50B"
  /\$\s?([\d,]+(?:\.\d+)?)\s*([MBKmk](?:illion|illion)?)?/g,
  // "200,000 BTC" / "50 goals" / "100 points"
  /([\d,]+(?:\.\d+)?)\s*(BTC|ETH|SOL|XRP|goals?|points?|seats?|votes?|percent|%|bps)/gi,
  // "reach 200,000" / "above 150,000" / "exceed 1,000,000"
  /(?:reach|above|exceed|surpass|hit|break|top)\s+([\d,]+(?:\.\d+)?)/gi,
];

const MULTIPLIERS: Record<string, number> = {
  'k': 1_000, 'K': 1_000,
  'm': 1_000_000, 'M': 1_000_000, 'million': 1_000_000, 'Million': 1_000_000,
  'b': 1_000_000_000, 'B': 1_000_000_000, 'billion': 1_000_000_000, 'Billion': 1_000_000_000,
};

export function extractNumbers(text: string): ExtractedNumber[] {
  const results: ExtractedNumber[] = [];
  const seen = new Set<number>();

  // Currency amounts: "$200,000"
  for (const match of text.matchAll(NUMBER_REGEXES[0])) {
    let value = parseFloat(match[1].replace(/,/g, ''));
    if (match[2]) value *= (MULTIPLIERS[match[2].charAt(0)] ?? 1);
    if (seen.has(value)) continue;
    seen.add(value);
    results.push({
      raw: match[0],
      value,
      unit: '$',
      context: getContext(text, match.index ?? 0),
    });
  }

  // Unit amounts: "200,000 BTC"
  for (const match of text.matchAll(NUMBER_REGEXES[1])) {
    const value = parseFloat(match[1].replace(/,/g, ''));
    if (seen.has(value)) continue;
    seen.add(value);
    results.push({
      raw: match[0],
      value,
      unit: match[2].toLowerCase(),
      context: getContext(text, match.index ?? 0),
    });
  }

  // Threshold amounts: "reach 200,000"
  for (const match of text.matchAll(NUMBER_REGEXES[2])) {
    const value = parseFloat(match[1].replace(/,/g, ''));
    if (seen.has(value)) continue;
    seen.add(value);
    results.push({
      raw: match[0],
      value,
      unit: null,
      context: getContext(text, match.index ?? 0),
    });
  }

  return results;
}

function getContext(text: string, index: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + 40);
  return text.slice(start, end).trim();
}

const CURRENCY_REGEX = /\b(USD|EUR|GBP|JPY|CNY|INR|BTC|ETH|SOL|BNB|USDT|USDC)\b/gi;

export function extractCurrencies(text: string): string[] {
  const matches = text.match(CURRENCY_REGEX) ?? [];
  return [...new Set(matches.map((m) => m.toUpperCase()))];
}
