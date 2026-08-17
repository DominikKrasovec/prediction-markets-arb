/**
 * Kalshi event grouping classifier: pure, deterministic, no I/O.
 * `classifyKalshiEvents` (sync.ts) assigns one verdict per `platform_event_id`.
 * Decision order: any BUNDLE title match wins -> bundle_nonexclusive; else any
 * CATEGORICAL title match -> categorical_exclusive; else unknown.
 */

export type KalshiGrouping =
  | 'categorical_exclusive'
  | 'bundle_nonexclusive'
  | 'unknown';

/** Bundle patterns, checked first; a single match anywhere in the title set forces bundle_nonexclusive. */
const KALSHI_BUNDLE_PATTERNS: readonly RegExp[] = [
  /^which +[a-z]+s\b/i,
  /^which +[a-z]+ +[a-z]+s\b/i,
  /^which +[a-z]+ +[a-z]+ +[a-z]+s\b/i,
  /^who +will +run +for +[a-z\s]*nomination\b/i,
  /^who +will +(ipo|dissent|recognize|qualify|feature +on)\b/i,
  /^who +will +be +named +in\b/i,
  /^who +will +host +.+ (season|series|tour|round)\b/i,
  /^who +will +perform +at +.+halftime\b/i,
];

/** Categorical patterns, checked after bundle; a match in an otherwise bundle-free title set yields categorical_exclusive. */
const KALSHI_CATEGORICAL_PATTERNS: readonly RegExp[] = [
  /^who +will +win\b/i,
  /^which +[a-z]+ +will +win\b/i,
  /^who +will +be +(the +)?next +[a-z]/i,
  /^who +will +be +trump'?s +next\b/i,
  /^who +will +be +announced +as +.+successor\b/i,
  /^who +will +(be|hold) +(the +)?[a-z][a-z\s]*?title +(holder +)?(on|by|at)\b/i,
  /^who +will +be +(the +)?(top\b|#1\b|cover\b|sexiest\b)/i,
  /^who +will +be +fantasy +football:/i,
  /^who +will +headline\b/i,
  /^who +will +(perform|sing|record) +the +(next|new)\b/i,
  /^who +will +be +picked +(1st|2nd|3rd|4th|5th|first|second|third|#?\d+)\b/i,
];

/** Replace every occurrence of `candidate` in `rule` with `{x}`, Unicode-aware so non-ASCII names still match. */
function templateRule(rule: string, candidate: string | null): string {
  if (!candidate) return rule;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  return rule.replace(matcher, '{x}');
}

/** Per-event template extraction over sibling markets: candidate substituted with `{x}`, most-voted template wins. Null template means no rule contained its candidate verbatim. */
export interface TemplateExtraction {
  template: string | null;
  vote_count: number;
  total_with_rule: number;
  vote_ratio: number;
}

export function extractKalshiTemplate(
  markets: readonly { rules_primary: string | null; candidate: string | null }[]
): TemplateExtraction {
  const templates = new Map<string, number>();
  let totalWithRule = 0;
  for (const m of markets) {
    const rule = (m.rules_primary ?? '').trim();
    if (!rule) continue;
    totalWithRule++;
    const candidate = m.candidate?.trim() || null;
    const templated = templateRule(rule, candidate);
    if (templated.includes('{x}')) {
      templates.set(templated, (templates.get(templated) ?? 0) + 1);
    }
  }
  if (templates.size === 0) {
    return { template: null, vote_count: 0, total_with_rule: totalWithRule, vote_ratio: 0 };
  }
  let bestTemplate: string | null = null;
  let bestCount = 0;
  for (const [t, n] of templates) {
    if (n > bestCount) { bestTemplate = t; bestCount = n; }
  }
  return {
    template: bestTemplate,
    vote_count: bestCount,
    total_with_rule: totalWithRule,
    vote_ratio: totalWithRule > 0 ? bestCount / totalWithRule : 0,
  };
}

/** Promotes 'unknown' to 'categorical_exclusive' when >=4 siblings and >=80% vote the same template. */
export function templatePromotesToCategorical(t: TemplateExtraction): boolean {
  return t.vote_count >= 4 && t.vote_ratio >= 0.8;
}

/** A "≥N" monotonic threshold qualifier surviving in a template; excludes bare years, ordinals and exact values. */
const MONOTONIC_THRESHOLD_RX =
  /\b\d[\d,.]*\s*\+|\b\d[\d,.]*\s+or\s+(?:more|fewer|less|greater)\b|\b(?:at least|at most|more than|fewer than|less than|no more than|no fewer than|over|under|above|below|greater than)\s+\$?\d/i;

const CUMULATIVE_CANDIDATE_RX =
  /^\s*\$?\d[\d,.]*\s*\+|^\s*(?:at least|at most|more than|fewer than|less than|no more than|no fewer than|over|under|above|below|greater than)\s+\$?\d/i;

/** Refuses promoting a monotonic-threshold set (independent numeric bars or ladder rungs) to categorical_exclusive — both break exactly-one-YES. */
export function isMonotonicThresholdPromotion(
  t: TemplateExtraction,
  candidates: readonly (string | null | undefined)[],
): boolean {
  if (t.template && MONOTONIC_THRESHOLD_RX.test(t.template)) return true;
  const nonEmpty = candidates.filter((c): c is string => !!c && c.trim().length > 0);
  if (nonEmpty.length < 4) return false;
  const hits = nonEmpty.filter((c) => CUMULATIVE_CANDIDATE_RX.test(c)).length;
  return hits >= nonEmpty.length * 0.8;
}

/** Kalshi `strike_type` values that are a monotonic half-line bound, so such siblings form a ladder, never a one-winner mutex. */
const MONOTONIC_STRIKE_TYPES = new Set([
  'greater',
  'greater_or_equal',
  'less',
  'less_or_equal',
]);

/** Refuses promoting a monotonic-ladder set when >=80% of children carry a half-line strike_type; excludes genuine >=2-subject spread mutexes. */
export function isMonotonicStrikeTypePromotion(
  strikeTypes: readonly (string | null | undefined)[],
  subjectCount: number,
): boolean {
  if (subjectCount >= 2) return false;
  const present = strikeTypes.filter((s): s is string => !!s && s.trim().length > 0);
  if (present.length < 4) return false;
  const hits = present.filter((s) => MONOTONIC_STRIKE_TYPES.has(s.trim().toLowerCase())).length;
  return hits >= present.length * 0.8;
}

/** Independent/ladder-selection templates (many siblings can resolve YES at once), matched on the {x}-substituted rule. */
const INDEPENDENT_SELECTION_RX = new RegExp([
  String.raw`\bselected for the .*\bsquad\b`,
  String.raw`\bin the .*\bsquad\b`,
  String.raw`\bhas been nominated\b`,
  String.raw`\bis a nominee\b`,
  String.raw`\bnominated for\b`,
  String.raw`\bqualif(?:y|ies|ied) for\b`,
  String.raw`\bone of the teams to qualify\b`,
  String.raw`\b(?:playoffs?)\s+qualifiers?\b`,
  String.raw`\b(?:is\s+)?ranked\s+top\s+\d`,
  String.raw`\bfinish(?:es|ing)?\s+(?:in\s+the\s+)?top\s+\d`,
  String.raw`\bhas a (?:#\s*1|top\s+\d+)\s+(?:song|single|album|hit)\b`,
  String.raw`\bis #?\s*1 on .* in [A-Z][a-z]+ \d{4}\b`,
  String.raw`\breleas(?:es|e|ed)\s+a\s+new\s+(?:album|song|single|ep|mixtape)\b`,
  String.raw`\bsays\s+\{x\}`,
  String.raw`\b(?:makes?|made|making|to\s+make)\s+the\s+cut\b`,
  String.raw`\b(?:records?|makes?|hits?|scores?)\s+an?\s+(?:eagle|hole[- ]in[- ]one|albatross)\b`,
  String.raw`\b#?\s*1\s+seed\b`,
  String.raw`\btop\s+\d+\s+(?:search(?:es)?|trend(?:s|ing)?)\b`,
].join('|'), 'i');

/** Refuses promoting an independent/ladder selection set to categorical_exclusive via the shared-template path. */
export function isIndependentSelectionPromotion(t: TemplateExtraction): boolean {
  return !!t.template && INDEPENDENT_SELECTION_RX.test(t.template);
}

/** Grouping from the platform-native `mutually_exclusive` settlement fact: true->categorical_exclusive, false->bundle_nonexclusive, null->no signal (caller keeps its title/template verdict). */
export function nativeMutexGrouping(mutuallyExclusive: boolean | null): KalshiGrouping | null {
  if (mutuallyExclusive === true) return 'categorical_exclusive';
  if (mutuallyExclusive === false) return 'bundle_nonexclusive';
  return null;
}

/** Single-title heuristic; prefer `classifyKalshiEvent` for the authoritative multi-row decision. */
export function classifyKalshiTitle(title: string | null | undefined): KalshiGrouping {
  if (!title) return 'unknown';
  if (KALSHI_BUNDLE_PATTERNS.some((rx) => rx.test(title))) return 'bundle_nonexclusive';
  if (KALSHI_CATEGORICAL_PATTERNS.some((rx) => rx.test(title))) return 'categorical_exclusive';
  return 'unknown';
}

/** Event-level classifier; sees every sibling title for one Kalshi event. */
export function classifyKalshiEvent(titles: readonly (string | null | undefined)[]): KalshiGrouping {
  if (titles.length === 0) return 'unknown';
  let hasCategorical = false;
  for (const t of titles) {
    if (!t) continue;
    if (KALSHI_BUNDLE_PATTERNS.some((rx) => rx.test(t))) return 'bundle_nonexclusive';
    if (!hasCategorical && KALSHI_CATEGORICAL_PATTERNS.some((rx) => rx.test(t))) {
      hasCategorical = true;
    }
  }
  return hasCategorical ? 'categorical_exclusive' : 'unknown';
}
