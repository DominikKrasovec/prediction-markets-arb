// Deterministic normalization for canonical_event noun phrases; also serves
// as the canonical row in the known_entities KB for type='event_name'.

import { foldAscii } from '../db/entity/tokens.js';

const COUNTRY_ADJECTIVE_TO_NOUN: Record<string, string> = {
  american: 'usa', argentine: 'argentina', argentinian: 'argentina',
  bolivian: 'bolivia', brazilian: 'brazil', canadian: 'canada',
  chilean: 'chile', colombian: 'colombia', cuban: 'cuba',
  ecuadorian: 'ecuador', guatemalan: 'guatemala', haitian: 'haiti',
  honduran: 'honduras', mexican: 'mexico', nicaraguan: 'nicaragua',
  panamanian: 'panama', paraguayan: 'paraguay', peruvian: 'peru',
  uruguayan: 'uruguay', venezuelan: 'venezuela',
  albanian: 'albania', austrian: 'austria', belgian: 'belgium',
  bulgarian: 'bulgaria', croatian: 'croatia', czech: 'czechia',
  danish: 'denmark', dutch: 'netherlands', english: 'england',
  estonian: 'estonia', finnish: 'finland', french: 'france',
  german: 'germany', greek: 'greece', hungarian: 'hungary',
  icelandic: 'iceland', irish: 'ireland', italian: 'italy',
  latvian: 'latvia', lithuanian: 'lithuania', moldovan: 'moldova',
  norwegian: 'norway', polish: 'poland', portuguese: 'portugal',
  romanian: 'romania', russian: 'russia', scottish: 'scotland',
  serbian: 'serbia', slovak: 'slovakia', slovenian: 'slovenia',
  spanish: 'spain', swedish: 'sweden', swiss: 'switzerland',
  turkish: 'turkey', ukrainian: 'ukraine', welsh: 'wales',
  afghan: 'afghanistan', australian: 'australia', bangladeshi: 'bangladesh',
  cambodian: 'cambodia', chinese: 'china', egyptian: 'egypt',
  filipino: 'philippines', indian: 'india', indonesian: 'indonesia',
  iranian: 'iran', iraqi: 'iraq', israeli: 'israel',
  japanese: 'japan', jordanian: 'jordan', kazakh: 'kazakhstan',
  kenyan: 'kenya', korean: 'korea', kuwaiti: 'kuwait',
  malaysian: 'malaysia', moroccan: 'morocco', nepalese: 'nepal',
  nigerian: 'nigeria', pakistani: 'pakistan', saudi: 'saudi arabia',
  singaporean: 'singapore', taiwanese: 'taiwan', thai: 'thailand',
  vietnamese: 'vietnam',
};

const COUNTRY_ADJECTIVES = Object.keys(COUNTRY_ADJECTIVE_TO_NOUN);

// Matches "Will <SUBJECT> [to] <VERB>" / "Who will <VERB>" preambles.
const LEADING_PREFIX_RX =
  /^(?:will\s+(?:the\s+)?[\p{L}\p{M}\p{N}.'\-]+(?:\s+[\p{L}\p{M}\p{N}.'\-]+){0,5}\s+(?:to\s+)?(?:win|reach|advance(?:\s+to)?|make(?:\s+it)?(?:\s+to)?|be\s+the)\s+|who\s+will\s+(?:win|reach|advance(?:\s+to)?|hold|be(?:\s+the)?)\s+)(?:the\s+)?/iu;

const LEADING_ARTICLE_RX = /^(?:the|next|a|an)\s+/i;

// yearHint injected as a leading token only when absent. Returns '' for null/empty input.
export function normalizeEventNoun(raw: string | null | undefined, yearHint?: number | null): string {
  if (!raw) return '';
  let s = raw.trim();
  if (s.length === 0) return '';

  s = s.replace(/[?!.]+\s*$/, '').trim();
  s = s.replace(LEADING_PREFIX_RX, '').trim();
  s = s.replace(LEADING_ARTICLE_RX, '').trim();

  // foldAscii before lowercasing, or accented nouns lose the letter below.
  s = foldAscii(s).toLowerCase().replace(/\s+/g, ' ');

  s = s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Trailing date suffix: the date already lives in condition_date.
  const DATE_MONTHS =
    'january|february|march|april|may|june|july|august|september|october|november|december|' +
    'jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';
  s = s.replace(
    new RegExp(
      `\\s+(?:on|by|at the end of)\\s+(?:${DATE_MONTHS})\\s+\\d{1,2}(?:\\s+\\d{4})?` +
        `(?:\\s+at\\s+\\d{1,2}\\s*(?:am|pm)?(?:\\s+[a-z]{2,4})?)?$`,
    ),
    '',
  ).trim();

  for (const adj of COUNTRY_ADJECTIVES) {
    const rx = new RegExp(`\\b${adj}\\b`, 'g');
    if (rx.test(s)) {
      s = s.replace(rx, COUNTRY_ADJECTIVE_TO_NOUN[adj]!);
    }
  }

  s = s
    .replace(/\b(?:champion|nominee|nomination|title)\b/g, 'winner')
    .replace(/\bwinner\s+holder\b/g, 'winner')
    .replace(/\bfifa world cup\b/g, 'world cup')
    .replace(/\bsoccer world cup\b/g, 'world cup')
    .replace(/\bmen s world cup\b/g, 'world cup')
    .replace(/\bus presidential election\b/g, 'presidential election')
    .replace(/\b(?:pga(?:\s+tour)?|lpga(?:\s+tour)?|golf)\s+majors?\b/g, 'major')
    .replace(/\bmajors\b/g, 'major')
    .replace(/\b(?:atp|wta|tennis)\s+grand\s+slams?\b/g, 'grand slam')
    .replace(/\bgrand\s+slams\b/g, 'grand slam')
    .replace(/\s+/g, ' ').trim();

  s = s.replace(/\s+winner$/i, '').trim();

  s = s.replace(/^final of (?:the )?/i, '').trim();

  // Guarded by "no other 4-digit year already present".
  const trailingYearMatch = /^(.+?)\s+in\s+(20\d{2})$/i.exec(s);
  if (trailingYearMatch) {
    const head = trailingYearMatch[1]!.trim();
    const year = trailingYearMatch[2]!;
    if (!/\b20\d{2}\b/.test(head)) {
      s = `${year} ${head}`;
    }
  }

  const hasExplicitYear = /\b(20\d{2})\b/.test(s);
  if (!hasExplicitYear && yearHint != null && Number.isInteger(yearHint) && yearHint >= 2020 && yearHint <= 2099) {
    s = `${yearHint} ${s}`;
  }

  return s.trim();
}

// Normalizes a per-fixture canonical_event string. Regex-only (no DB/KB
// lookups) so it applies identically at Stage 1 emit time and in SQL backfills.
const FIXTURE_PREFIX_RX =
  /^(LoL|Dota\s*2|CS\s*2|CSGO|Valorant|CoD|Call\s+of\s+Duty|Rocket\s+League|R6|Rainbow\s+Six|BUNDL|EPL|BPL|MLS|MLB|NBA|NHL|NFL|UFC|World\s+Cup\s+Qualifier|World\s+Cup|UEFA(?:\s+Champions\s+League|\s+Europa\s+League)?|Champions\s+League|Coupe\s*de\s*Fra|CoupeDeFra|Copa\s+Libertadores|Copa\s+do\s+Brasil)\s*[:,]\s*/i;

const FIXTURE_SUFFIX_RX =
  /\s*\(?BO\d+\)?\s*$|[,\s]+(?:on\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,?\s+\d{4})?\s*\??\s*$/i;

// "end in a draw" must be checked before "win" or it mis-collapses onto win.
const FIXTURE_QUESTION_SUFFIX_RX =
  /\s+end\s+in\s+a\s+draw\s*\??$|\s+win\s+on\s+\d{4}-\d{2}-\d{2}\s*\??$|\s+win\s+Group\s+[A-Z]\s*\??$|\s+win\s+the\s+match\s*\??$|\s+winner\s*\??$/i;

// Anchored to ": <token>[?]" at the end only, so a colon in a team name is untouched.
const FIXTURE_MARKET_TYPE_SUFFIX_RX =
  /:\s*(?:\d+\+\s+(?:total\s+)?(?:goals?|cards?|corners?|hits?|bases?|points?|kills?|maps?|sets?|games?|runs?|fouls?|rebounds?|assists?|sixes?|aces?|home\s+runs?)|(?:match\s+|total\s+sets?\s+|set\s+\d+\s+games?\s+|1h\s+|2h\s+)?o\/u\s+\d+(?:\.\d+)?|both\s+teams?\s+to\s+score|btts|total\s+(?:goals?|cards?|corners?|points?|kills?|sets?|games?|runs?|rebounds?|assists?)|moneyline|draw\s+at\s+halftime|exact\s+score|halftime\s+result|first\s+half\s+winner|second\s+half\s+winner)\s*\??\s*$/i;

const LEADING_WILL_RX = /^Will\s+/i;
const TRAILING_QMARK_RX = /\s*\?\s*$/;

export function normalizeFixtureCanonicalEvent(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.trim();
  s = s.replace(FIXTURE_PREFIX_RX, '');
  s = s.replace(FIXTURE_QUESTION_SUFFIX_RX, '');
  s = s.replace(FIXTURE_MARKET_TYPE_SUFFIX_RX, '');
  s = s.replace(FIXTURE_SUFFIX_RX, '');
  s = s.replace(LEADING_WILL_RX, '');
  s = s.replace(TRAILING_QMARK_RX, '');
  s = s.replace(/\s+vs\.\s+/gi, ' vs ');
  // Only when preceded by another word, so a leading "FC Barcelona" is preserved.
  s = s.replace(/\s+(FC|BC|AC|CF|SC|CD|AFC|United)\s+/gi, ' ');
  s = s.replace(/\s+(FC|BC|AC|CF|SC|CD|AFC)\b\s*$/i, '');
  s = s.replace(/\s+1[89]\d{2}\b/, '');
  s = s.replace(/\s+/g, ' ').trim();
  const vsMatch = /^([^:]+?)\s+vs\s+([^:]+?)$/i.exec(s);
  if (vsMatch) {
    const a = vsMatch[1]!.trim();
    const b = vsMatch[2]!.trim();
    s = a.toLowerCase() < b.toLowerCase() ? `${a} vs ${b}` : `${b} vs ${a}`;
  }
  return s;
}

// Returns null for null/empty/whitespace-only input.
export function normalizeOutcomeLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^[↑↓→←]\s*\$?[\d.,]+[KMB]?\s*/u, '');
  s = s.replace(/\s*\([^)]*\)\s*$/g, '');
  s = s.toLowerCase();
  s = s.replace(/^(republican\s+party|republicans)$/i, 'republican');
  s = s.replace(/^(democratic\s+party|democrats|democrat)$/i, 'democratic');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length === 0 ? null : s;
}

// Embedded in canonical_key, so plural/hyphen forms must agree byte-for-byte.
export function normalizePlayerStatUnit(
  raw: string | null | undefined,
  fallback: string = 'count',
): string {
  if (!raw) return fallback;
  const s = raw.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (!s) return fallback;

  const stems: Record<string, string> = {
    'home run': 'home_runs',
    'home runs': 'home_runs',
    'three pointer': 'threes',
    'three pointers': 'threes',
    'three': 'threes',
    'threes': 'threes',
    'stolen base': 'stolen_bases',
    'stolen bases': 'stolen_bases',
    'passing yard': 'passing_yards',
    'passing yards': 'passing_yards',
    'rushing yard': 'rushing_yards',
    'rushing yards': 'rushing_yards',
    'receiving yard': 'receiving_yards',
    'receiving yards': 'receiving_yards',
  };
  if (stems[s]) return stems[s]!;

  const pluralized = /s$/.test(s) ? s : `${s}s`;
  return pluralized.replace(/\s+/g, '_');
}

export function yearFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  if (!m) return null;
  const y = parseInt(m[1]!, 10);
  return y >= 2020 && y <= 2099 ? y : null;
}

// Opt into canonical_event normalization via normalizeEventNoun.
export const EVENT_ANCHORED_KINDS = new Set<string>([
  'election_outcome_winner',
  'championship_winner',
  'stage_advance',
]);

// First-match-wins: EVENT_ANCHORED_KINDS → player-stat prop → sports H2H → fallback.
export function deriveCanonicalEventCore(input: {
  eventKind: string | null;
  conditionShape: string | null;
  conditionMetric: string | null;
  valueUnit: string | null;
  rawCanonicalEvent: string;
  canonicalSubject: string;
  canonicalParticipants: string[];
  categoryUnified: string | null;
  eventDateIso: string | null;
}): string {
  const { eventKind, conditionShape, conditionMetric, valueUnit, rawCanonicalEvent,
          canonicalSubject, canonicalParticipants, categoryUnified, eventDateIso } = input;

  if (eventKind && EVENT_ANCHORED_KINDS.has(eventKind)) {
    return normalizeEventNoun(rawCanonicalEvent, yearFromIso(eventDateIso)) || rawCanonicalEvent;
  }

  // personnel_move / participation carry a club/team/opponent as a
  // PARTICIPANT; without this guard they'd fall into sports H2H below and
  // mint a false fixture (e.g. player vs club).
  if (eventKind === 'personnel_move') {
    const club = canonicalParticipants.find(
      (p) => p && p.toLowerCase() !== canonicalSubject.toLowerCase(),
    );
    if (conditionShape === 'categorical_outcome' && club) {
      return `next ${club.toLowerCase()} manager`;
    }
    return normalizeFixtureCanonicalEvent(rawCanonicalEvent) || rawCanonicalEvent;
  }
  if (eventKind === 'participation') {
    return normalizeFixtureCanonicalEvent(rawCanonicalEvent) || rawCanonicalEvent;
  }

  // Excludes finish-position markets (condition_metric=null, value_unit='rank'),
  // which supply their own canonical_event_override.
  if (
    eventKind === 'player_prop_threshold' &&
    conditionMetric === 'count' &&
    categoryUnified === 'sports' &&
    canonicalSubject &&
    valueUnit
  ) {
    return `${canonicalSubject} ${valueUnit}`;
  }

  if (
    categoryUnified === 'sports' &&
    (conditionShape === 'binary_event' ||
      conditionShape === 'monotonic_threshold' ||
      conditionShape === 'point_in_time' ||
      conditionShape === 'categorical_outcome')
  ) {
    const opponents = canonicalParticipants.filter((p) => p && p !== canonicalSubject);
    if (opponents.length === 1) {
      const a = canonicalSubject;
      const b = opponents[0]!;
      return a.toLowerCase() < b.toLowerCase() ? `${a} vs ${b}` : `${b} vs ${a}`;
    }
    if (opponents.length === 2) {
      const [a, b] = opponents as [string, string];
      return a.toLowerCase() < b.toLowerCase() ? `${a} vs ${b}` : `${b} vs ${a}`;
    }
    return normalizeFixtureCanonicalEvent(rawCanonicalEvent) || rawCanonicalEvent;
  }

  return rawCanonicalEvent;
}

// match_total_metric/both_teams_score/match_event_prop are symmetric over the
// two teams, yet Stage-1 templates set canonical_subject to the first team,
// so the same outcome in the other team order never merges. Returns the
// fixture string to stamp as canonical_subject, or null to keep the existing
// subject. Never register the returned string as a KB entity — only real teams.
export function fixtureSubjectOverride(input: {
  eventKind: string | null | undefined;
  metricScope: string | null | undefined;
  participantCount: number;
  canonicalEvent: string | null | undefined;
}): string | null {
  if (input.eventKind !== 'match_total_metric' && input.eventKind !== 'both_teams_score'
      && input.eventKind !== 'match_event_prop') return null;
  if (input.metricScope === 'team') return null;
  if (input.participantCount < 2) return null;
  if (!input.canonicalEvent) return null;
  return input.canonicalEvent;
}
