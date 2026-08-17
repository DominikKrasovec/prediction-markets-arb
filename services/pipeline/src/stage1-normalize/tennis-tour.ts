// Tennis tour (ATP/WTA) discriminator lift — Stage 1. Kalshi tennis championship
// titles carry no tour/gender token, so canonical_event would otherwise collapse
// both tours onto one string. Never guesses: unknown/ambiguous/mixed-tour -> null.

export type TourGender = 'men' | 'women';

export interface TourSignals {
  title: string;
  eventTitle?: string | null;
  kalshiCompetition?: string | null;
  eventTicker?: string | null;
  rulesPrimary?: string | null;
}

// test women BEFORE men everywhere — "WOMEN".endsWith("MEN") in the ticker path.
const WOMEN_RX = /\bwomen(?:['’]?s)?\b/i;
const MEN_RX = /\bmen(?:['’]?s)?\b/i;
const WTA_RX = /\bwta\b/i;
const ATP_RX = /\batp\b/i;

const MIXED_RX = /\bmixed\b|\bunited\s+cup\b/i;

// gates weak signals — without it a gendered non-tennis title would split a sound merge.
const TENNIS_CONTEXT_RX =
  /\b(?:tennis|atp|wta|grand\s+slam|roland\s+garros|wimbledon|french\s+open|australian\s+open|us\s+open)\b/i;

function genderToken(s: string | null | undefined): TourGender | null {
  if (!s) return null;
  if (WTA_RX.test(s)) return 'women';
  if (ATP_RX.test(s)) return 'men';
  if (WOMEN_RX.test(s)) return 'women';
  if (MEN_RX.test(s)) return 'men';
  return null;
}

export function deriveTennisTour(s: TourSignals): TourGender | null {
  const hay = [s.title, s.eventTitle, s.kalshiCompetition, s.rulesPrimary];
  if (hay.some((h) => h && MIXED_RX.test(h))) return null;

  const comp = s.kalshiCompetition?.trim();
  if (comp) {
    if (/^wta\b/i.test(comp)) return 'women';
    if (/^atp\b/i.test(comp)) return 'men';
  }

  for (const h of [s.title, s.eventTitle]) {
    if (!h) continue;
    if (WTA_RX.test(h)) return 'women';
    if (ATP_RX.test(h)) return 'men';
  }

  if (!hay.some((h) => h && TENNIS_CONTEXT_RX.test(h))) return null;
  for (const h of [s.title, s.eventTitle]) {
    const g = genderToken(h);
    if (g) return g;
  }
  const series = s.eventTicker?.split('-')[0]?.toUpperCase();
  if (series) {
    if (series.endsWith('WOMEN')) return 'women'; // before MEN check — "…WOMEN".endsWith("MEN") is true
    if (series.endsWith('MEN')) return 'men';
  }
  const gRules = genderToken(s.rulesPrimary);
  if (gRules) return gRules;

  return null;
}

// registry entry `tour_gender`; only title + canonical_event are available at the Stage-1 emission door.
export function tourGenderDiscriminator(
  title: string,
  canonicalEvent: string | null | undefined,
): TourGender | null {
  return deriveTennisTour({ title, eventTitle: canonicalEvent ?? null });
}

// only when an explicit ATP/WTA signal is present; bare "Men's" doesn't prove the circuit (could be juniors/ITF).
export function tennisTourLeague(s: TourSignals): 'ATP Tour' | 'WTA Tour' | null {
  const hay = [s.kalshiCompetition, s.title, s.eventTitle];
  if (hay.some((h) => h && MIXED_RX.test(h))) return null;
  for (const h of hay) {
    if (!h) continue;
    if (WTA_RX.test(h)) return 'WTA Tour';
    if (ATP_RX.test(h)) return 'ATP Tour';
  }
  return null;
}

// Unchanged when already gender- or tour-qualified, or for any-of-K families
// ("2026 grand slam") which must stay tour-folded (not single-winner events).
export function qualifyTourCanonicalEvent(core: string, tour: TourGender): string {
  if (!core) return core;
  if (/\b(?:men|women)s?\b/.test(core)) return core;
  if (/\b(?:atp|wta)\b/.test(core)) return core;
  if (/\b(?:grand slam|major)s?$/.test(core)) return core;
  const q = tour === 'men' ? 'men s' : 'women s';
  const m = /^(\d{4}) (.*)$/.exec(core);
  return m ? `${m[1]} ${q} ${m[2]}` : `${q} ${core}`;
}
