/**
 * Deterministic event-date extractor: pulls the "when does the market's underlying
 * event happen" timestamp from the most reliable platform-specific signal — slug,
 * Kalshi ticker, parlay legs, or title — falling back to `markets.end_date` only
 * when none of those carry a date. `end_date` is a *resolution* time shaped by
 * per-platform settlement policy, not the *event* time Stage 2/3 matching needs.
 * `precision` tells Stage 2/3 the comparison tolerance (minute=exact, hour=±1h,
 * day=day-equality, month/year=fall back to canonical_event grouping).
 */

import { stampConditionDate } from '../util/condition-date.js';

export type EventDatePrecision = 'minute' | 'hour' | 'day' | 'month' | 'year';

export type EventDateSource =
  | 'limitless-candle-open' | 'slug-unix-ms' | 'slug-unix-sec' | 'slug-iso'
  | 'kalshi-ticker-minute' | 'kalshi-ticker-hour' | 'kalshi-ticker-day'
  | 'kalshi-ticker-month' | 'kalshi-ticker-year' | 'kalshi-leg-min'
  | 'title-week-of' | 'title-iso' | 'title-mdy' | 'title-md'
  | 'title-month-year' | 'title-month-deadline' | 'title-year' | 'end_date';

export interface EventDate {
  /** Either 'YYYY-MM-DD' (day precision and coarser) or 'YYYY-MM-DDTHH:MM:SSZ'. */
  iso: string;
  precision: EventDatePrecision;
  source: EventDateSource;
  tzAssumed: 'UTC' | 'ET';
}

export interface ExtractEventDateInput {
  platform: string;
  platform_id: string;
  title: string;
  slug: string | null;
  end_date: string | null;
  mve_selected_legs?: { side: string; market_ticker: string }[] | null;
}

const SLUG_UNIX_MS_RX = /-(1\d{12})$/;
const SLUG_UNIX_SEC_RX = /-updown-[a-z0-9]+-(1\d{9})$/i;
const SLUG_ISO_RX = /(20[2-3]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/;

const KALSHI_TICKER_MIN_RX  = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})(\d{2})(?=[-A-Z0-9]|$)/;
const KALSHI_TICKER_HOUR_RX = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})(?=[-A-Z0-9]|$)/;
const KALSHI_TICKER_DAY_RX  = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(?=[-A-Z0-9]|$)/;
const KALSHI_TICKER_MON_RX  = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?=-|$)/;
// election/award year-cycle tag (e.g. `KXBRPRES-26-LULA`), must not shadow the month patterns above
const KALSHI_TICKER_YEAR_ONLY_RX = /-(\d{2})-(?!(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))/;
// tournament-code year tag (e.g. `KXPGAH2H-TRC26LABEXSCH-XSCH` → 2026); last-resort fallback
const KALSHI_TICKER_TOURNAMENT_YEAR_RX = /-(?!(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))[A-Z]{2,6}(\d{2})(?=[A-Z]|-|$)/;

const KALSHI_MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const TITLE_MDY_RX = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20[2-3]\\d)\\b`, 'i');
const TITLE_MD_RX  = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const TITLE_MONTH_YEAR_RX = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(20[2-3]\\d)\\b`, 'i');
// bare-month deadline, no year/day (the year/day branches run first, so a match here is guaranteed bare)
const TITLE_MONTH_DEADLINE_RX = new RegExp(
  `\\bby\\s+end\\s+of\\s+${MONTH_NAME}\\b|\\bhit\\b.*?\\bin\\s+${MONTH_NAME}\\b`,
  'i',
);
// equity "week of <Month DD>" names the week by MONDAY but resolves at FRIDAY close;
// this re-anchors to that Friday so the stamp is the actual resolution moment
const TITLE_WEEK_OF_RX = new RegExp(`\\bweek\\s+of\\s+${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20[2-3]\\d))?`, 'i');
const TITLE_ISO_RX = /\b(20[2-3]\d)-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/;
const TITLE_YEAR_RX = /\b(20[2-3]\d)\b/;
const TITLE_TIME_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))?\s+(et|edt|est|utc|ct|cdt|cst|pt|pdt|pst|gmt)\b/i;

const MONTH_NUM: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function extractEventDate(row: ExtractEventDateInput): EventDate | null {
  // must run before the slug branches (Limitless slug-unix-ms is post time, not event time)
  if (row.platform === 'limitless' && row.end_date) {
    const limitlessOpen = extractLimitlessCandleOpen(row.title, row.end_date);
    if (limitlessOpen) return limitlessOpen;
  }

  // gated to non-Limitless: Limitless's slug-unix-ms is a post timestamp, not event time
  if (row.slug && row.platform !== 'limitless') {
    const m = SLUG_UNIX_MS_RX.exec(row.slug);
    if (m) {
      const ms = Number(m[1]);
      if (Number.isFinite(ms) && ms > 1_500_000_000_000 && ms < 2_500_000_000_000) {
        const iso = new Date(ms).toISOString();
        return { iso: iso.slice(0, 17) + '00Z', precision: 'minute', source: 'slug-unix-ms', tzAssumed: 'UTC' };
      }
    }
  }

  if (row.slug) {
    const m = SLUG_UNIX_SEC_RX.exec(row.slug);
    if (m) {
      const sec = Number(m[1]);
      if (Number.isFinite(sec) && sec > 1_500_000_000 && sec < 2_500_000_000) {
        const iso = new Date(sec * 1000).toISOString();
        return { iso: iso.slice(0, 17) + '00Z', precision: 'minute', source: 'slug-unix-sec', tzAssumed: 'UTC' };
      }
    }
  }

  if (row.slug) {
    const m = SLUG_ISO_RX.exec(row.slug);
    if (m) {
      const iso = `${m[1]}-${m[2]}-${m[3]}`;
      if (isValidYmd(iso)) {
        return { iso, precision: 'day', source: 'slug-iso', tzAssumed: 'UTC' };
      }
    }
  }

  if (row.platform === 'kalshi' && row.platform_id) {
    const direct = extractKalshiTicker(row.platform_id);
    if (direct) return direct;

    // coarsest precision across legs: a parlay's event-time is only as precise as its least-precise leg
    if (row.mve_selected_legs && row.mve_selected_legs.length > 0) {
      const legDates: EventDate[] = [];
      for (const leg of row.mve_selected_legs) {
        const ld = extractKalshiTicker(leg.market_ticker);
        if (ld) legDates.push(ld);
      }
      if (legDates.length > 0) {
        legDates.sort((a, b) => a.iso.localeCompare(b.iso));
        const earliest = legDates[0]!;
        const PRECISION_RANK: Record<EventDatePrecision, number> = {
          minute: 0, hour: 1, day: 2, month: 3, year: 4,
        };
        const coarsest = legDates.reduce<EventDatePrecision>(
          (acc, l) => (PRECISION_RANK[l.precision] > PRECISION_RANK[acc] ? l.precision : acc),
          'minute',
        );
        // month precision keeps 'YYYY-MM-01' (not 'YYYY-MM') so the iso stays ::date-castable
        const iso = coarsest === 'year' ? earliest.iso.slice(0, 4) + '-01-01'
                  : coarsest === 'month' ? earliest.iso.slice(0, 7) + '-01'
                  : earliest.iso.slice(0, 10);
        return {
          iso,
          precision: coarsest === 'minute' || coarsest === 'hour' ? 'day' : coarsest,
          source: 'kalshi-leg-min',
          tzAssumed: 'ET',
        };
      }
    }
  }

  // runs before title-mdy/title-md so the Monday anchor "May 11" never wins first
  {
    const m = TITLE_WEEK_OF_RX.exec(row.title);
    if (m) {
      const mo = MONTH_NUM[m[1]!.toLowerCase()];
      const day = parseInt(m[2]!, 10);
      if (mo && day >= 1 && day <= 31) {
        const year = m[3] ? parseInt(m[3], 10) : inferYear(mo, day, row.end_date);
        const friday = fridayOfIsoWeek(year, mo, day);
        if (friday) return { iso: friday, precision: 'day', source: 'title-week-of', tzAssumed: 'UTC' };
      }
    }
  }

  {
    const m = TITLE_ISO_RX.exec(row.title);
    if (m) {
      const iso = `${m[1]}-${pad(parseInt(m[2]!, 10))}-${pad(parseInt(m[3]!, 10))}`;
      if (isValidYmd(iso)) {
        const time = extractTimeOfDay(row.title);
        if (time) {
          const stamped = applyTimeOfDay(iso, time);
          return { iso: stamped.iso, precision: stamped.precision, source: 'title-iso', tzAssumed: 'UTC' };
        }
        return { iso, precision: 'day', source: 'title-iso', tzAssumed: 'UTC' };
      }
    }
  }

  {
    const m = TITLE_MDY_RX.exec(row.title);
    if (m) {
      const mo = MONTH_NUM[m[1]!.toLowerCase()];
      const d  = parseInt(m[2]!, 10);
      const y  = parseInt(m[3]!, 10);
      if (mo) {
        const iso = ymdString(y, mo, d);
        if (iso) {
          const time = extractTimeOfDay(row.title);
          if (time) {
            const stamped = applyTimeOfDay(iso, time);
            return { iso: stamped.iso, precision: stamped.precision, source: 'title-mdy', tzAssumed: 'UTC' };
          }
          return { iso, precision: 'day', source: 'title-mdy', tzAssumed: 'UTC' };
        }
      }
    }
  }

  // "Month DD" with no year — infer from end_date or current year
  {
    const m = TITLE_MD_RX.exec(row.title);
    if (m) {
      const mo = MONTH_NUM[m[1]!.toLowerCase()];
      const d  = parseInt(m[2]!, 10);
      if (mo) {
        const y = inferYear(mo, d, row.end_date);
        const iso = ymdString(y, mo, d);
        if (iso) {
          const time = extractTimeOfDay(row.title);
          if (time) {
            const stamped = applyTimeOfDay(iso, time);
            return { iso: stamped.iso, precision: stamped.precision, source: 'title-md', tzAssumed: 'UTC' };
          }
          return { iso, precision: 'day', source: 'title-md', tzAssumed: 'UTC' };
        }
      }
    }
  }

  // "Month YYYY" no day (e.g. "in May 2026?"): month-end day + 'month' precision, ISO-equal
  // to the "by end of <Month>" day-grain stamp so the two phrasings of one deadline fold together
  {
    const m = TITLE_MONTH_YEAR_RX.exec(row.title);
    if (m) {
      const stamped = stampConditionDate({
        kind: 'monthToken', mon: m[1]!, year: parseInt(m[2]!, 10), pad: 'end-month',
      });
      if (stamped) {
        return { iso: stamped.iso, precision: stamped.precision, source: 'title-month-year', tzAssumed: 'UTC' };
      }
    }
  }

  // bare-month deadline ("hit … in May?"/"by end of May?"): runs after every year/day
  // branch so the match is guaranteed bare, and before the end_date fallback so it
  // replaces the platform-buffered resolution timestamp; requires end_date for the year
  {
    const m = TITLE_MONTH_DEADLINE_RX.exec(row.title);
    if (m && row.end_date) {
      const monTok = m[1] ?? m[2]; // group 1 = by-end-of arm, group 2 = hit arm
      const mo = monTok ? MONTH_NUM[monTok.toLowerCase()] : undefined;
      if (mo) {
        let y = inferYear(mo, 28, row.end_date);
        // year-rollover guard: end_date-year borrow may place month-end >45d after end_date
        const endMs = Date.parse(row.end_date);
        if (Number.isFinite(endMs) && Date.UTC(y, mo, 0) - endMs > 45 * 86_400_000) y -= 1;
        const stamped = stampConditionDate({ kind: 'monthToken', mon: monTok!, year: y, pad: 'end-month' });
        if (stamped) {
          return { iso: stamped.iso, precision: stamped.precision, source: 'title-month-deadline', tzAssumed: 'UTC' };
        }
      }
    }
  }

  {
    const m = TITLE_YEAR_RX.exec(row.title);
    if (m) {
      return { iso: `${m[1]}-01-01`, precision: 'year', source: 'title-year', tzAssumed: 'UTC' };
    }
  }

  if (row.end_date) {
    const iso = row.end_date.slice(0, 10);
    if (isValidYmd(iso)) {
      return { iso, precision: 'day', source: 'end_date', tzAssumed: 'UTC' };
    }
  }

  return null;
}

const LIMITLESS_CANDLE_DURATION_RX =
  /\b(?:up\s+or\s+down|updown)\s*[-–]\s*(?<dur>5\s*mins?|15\s*mins?|30\s*mins?|1\s*hours?|hourly|4\s*hours?|1\s*days?|daily|weekly|1\s*weeks?)\b/i;

function parseLimitlessCandleDurationMin(s: string): number | null {
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (t === '5min' || t === '5mins') return 5;
  if (t === '15min' || t === '15mins') return 15;
  if (t === '30min' || t === '30mins') return 30;
  if (t === '1hour' || t === '1hours' || t === 'hourly') return 60;
  if (t === '4hour' || t === '4hours') return 240;
  if (t === '1day' || t === '1days' || t === 'daily') return 1440;
  if (t === '1week' || t === '1weeks' || t === 'weekly') return 10080;
  return null;
}

/** Candle OPEN time for a Limitless "Up or Down - <duration>" market (candle window's
 *  open moment, matching Polymarket's slug-unix-sec convention). */
function extractLimitlessCandleOpen(title: string, endDate: string): EventDate | null {
  const m = LIMITLESS_CANDLE_DURATION_RX.exec(title);
  if (!m?.groups?.dur) return null;
  const durMin = parseLimitlessCandleDurationMin(m.groups.dur);
  if (durMin == null) return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const openMs = endMs - durMin * 60_000;
  const iso = new Date(openMs).toISOString();
  return { iso: iso.slice(0, 17) + '00Z', precision: 'minute', source: 'limitless-candle-open', tzAssumed: 'UTC' };
}

function extractKalshiTicker(ticker: string): EventDate | null {
  let m = KALSHI_TICKER_MIN_RX.exec(ticker);
  if (m) {
    const iso = kalshiToIso(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
    if (iso) return { iso, precision: 'minute', source: 'kalshi-ticker-minute', tzAssumed: 'ET' };
  }
  m = KALSHI_TICKER_HOUR_RX.exec(ticker);
  if (m) {
    const iso = kalshiToIso(m[1]!, m[2]!, m[3]!, m[4]!);
    if (iso) return { iso, precision: 'hour', source: 'kalshi-ticker-hour', tzAssumed: 'ET' };
  }
  m = KALSHI_TICKER_DAY_RX.exec(ticker);
  if (m) {
    const iso = kalshiToIso(m[1]!, m[2]!, m[3]!);
    if (iso) return { iso, precision: 'day', source: 'kalshi-ticker-day', tzAssumed: 'ET' };
  }
  m = KALSHI_TICKER_MON_RX.exec(ticker);
  if (m) {
    const iso = kalshiToIso(m[1]!, m[2]!);
    if (iso) return { iso, precision: 'month', source: 'kalshi-ticker-month', tzAssumed: 'ET' };
  }
  m = KALSHI_TICKER_YEAR_ONLY_RX.exec(ticker);
  if (m) {
    const yy = parseInt(m[1]!, 10);
    const year = 2000 + yy;
    if (year >= 2020 && year <= 2099) {
      return { iso: `${year}-01-01`, precision: 'year', source: 'kalshi-ticker-year', tzAssumed: 'ET' };
    }
  }
  // final fallback so all structured patterns above win first
  m = KALSHI_TICKER_TOURNAMENT_YEAR_RX.exec(ticker);
  if (m) {
    const yy = parseInt(m[1]!, 10);
    if (yy >= 20 && yy <= 40) {
      const year = 2000 + yy;
      return { iso: `${year}-01-01`, precision: 'year', source: 'kalshi-ticker-year', tzAssumed: 'ET' };
    }
  }
  return null;
}

function kalshiToIso(yy: string, mon: string, dd?: string, hh?: string, mm?: string): string | null {
  const year = 2000 + parseInt(yy, 10);
  const month = KALSHI_MONTHS[mon];
  if (!month) return null;
  const day = dd ? parseInt(dd, 10) : 1;
  const hr  = hh ? parseInt(hh, 10) : 0;
  const min = mm ? parseInt(mm, 10) : 0;
  if (hr > 23 || min > 59) return null;
  const baseDate = ymdString(year, month, day);
  if (!baseDate) return null;
  if (hh) return `${baseDate}T${pad(hr)}:${pad(min)}:00`;
  return baseDate;
}

/** The Friday of the ISO (Mon-start) week containing anchor date `(y, m, d)`. */
function fridayOfIsoWeek(y: number, m: number, d: number): string | null {
  const anchorMs = Date.UTC(y, m - 1, d);
  const dt = new Date(anchorMs);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const dow = dt.getUTCDay();
  const isoDowMon0 = (dow + 6) % 7;
  const fridayMs = anchorMs - isoDowMon0 * 86_400_000 + 4 * 86_400_000;
  return new Date(fridayMs).toISOString().slice(0, 10);
}

function ymdString(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function isValidYmd(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  return ymdString(parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)) === iso;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Year inference for "Month DD" titles with no explicit year: prefer end_date's
 *  plausible year, else current year unless the result is >30 days in the past. */
function inferYear(month: number, day: number, endDateHint: string | null): number {
  const nowYear = new Date().getUTCFullYear();
  if (endDateHint) {
    const m = /^(\d{4})-/.exec(endDateHint);
    if (m) {
      const y = parseInt(m[1]!, 10);
      if (y >= nowYear - 1 && y <= nowYear + 5) return y;
    }
  }
  const candidateMs = Date.UTC(nowYear, month - 1, day);
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return candidateMs >= cutoffMs ? nowYear : nowYear + 1;
}

/** Extracts a time-of-day rider and converts to UTC via fixed zone offsets (DST
 *  exactness deferred). `dayCarry` (0 or 1) must be applied by the caller — a
 *  western-zone evening local time can fall on the next UTC calendar day. */
function extractTimeOfDay(
  title: string,
): { hh: string; mm: string; precision: 'minute' | 'hour'; dayCarry: number } | null {
  const m = TITLE_TIME_RX.exec(title);
  if (!m) return null;
  let hr = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]!.toLowerCase();
  if (ampm === 'pm' && hr < 12) hr += 12;
  if (ampm === 'am' && hr === 12) hr = 0;
  if (hr > 23 || min > 59) return null;

  const tz = m[4]!.toLowerCase();
  const offsetHours =
    tz === 'utc' || tz === 'gmt' ? 0 :
    tz === 'edt' || tz === 'et' ? 4 :
    tz === 'est' ? 5 :
    tz === 'cdt' || tz === 'ct' ? 5 :
    tz === 'cst' ? 6 :
    tz === 'pdt' || tz === 'pt' ? 7 :
    tz === 'pst' ? 8 :
    0;
  const shifted = hr + offsetHours;
  const utcHr = shifted % 24;
  const dayCarry = Math.floor(shifted / 24);

  return { hh: pad(utcHr), mm: pad(min), precision: m[2] ? 'minute' : 'hour', dayCarry };
}

/** 'YYYY-MM-DD' + n days (n ≥ 0), month/year rollover included. */
function addDaysIso(iso: string, n: number): string {
  if (!n) return iso;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/** Applies the UTC day-carry so an evening local time lands on the next UTC calendar day. */
export function applyTimeOfDay(
  isoDay: string,
  time: { hh: string; mm: string; precision: 'minute' | 'hour'; dayCarry: number },
): { iso: string; precision: EventDatePrecision } {
  return {
    iso: `${addDaysIso(isoDay, time.dayCarry)}T${time.hh}:${time.mm}:00Z`,
    precision: time.precision,
  };
}
