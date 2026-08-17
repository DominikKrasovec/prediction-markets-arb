import type { HierarchyType, ConditionShape, ConditionDirection, TemporalSemantics } from '@arb/types';

interface HierarchyResult {
  hierarchy_type: HierarchyType;
  hierarchy_value: string;
  hierarchy_level: number;
}

/** Regex-derived condition taxonomy signals (parallel to LLM extraction). */
interface ConditionSignals {
  condition_shape: ConditionShape | null;
  condition_direction: ConditionDirection | null;
  temporal_semantics: TemporalSemantics | null;
}

// Tournament round patterns (ordered by difficulty: lower = easier)
const TOURNAMENT_LEVELS: [RegExp, string, number][] = [
  [/\bfirst\s+round\b/i,          'first_round',    1],
  [/\bround\s+of\s+64\b/i,        'round_of_64',    1],
  [/\bround\s+of\s+32\b/i,        'round_of_32',    2],
  [/\bround\s+of\s+16\b/i,        'round_of_16',    3],
  [/\bsweet\s+sixteen\b/i,        'sweet_16',       3],
  [/\beighth[- ]?final\b/i,       'eighth_final',   3],
  [/\bquarter[- ]?final\b/i,      'quarterfinal',   4],
  [/\bsemi[- ]?final\b/i,         'semifinal',      5],
  [/\bthird[- ]?place\b/i,        'third_place',    5],  // same difficulty as semifinal
  [/\bfinals?\b/i,                 'final',          6],
  [/\bgrand\s+final\b/i,          'grand_final',    7],
  [/\bchampionship\b/i,           'championship',   7],
  [/\btitle\s+(?:game|match)\b/i, 'title_match',    7],
  // Sports-specific
  [/\bplayoff\b/i,                'playoff',        3],
  [/\bconference\s+finals?\b/i,   'conference_final', 5],
  [/\bdivision(?:al)?\s+round\b/i, 'divisional',    3],
  [/\bwild\s*card\b/i,            'wild_card',      2],
  // Sequential stages (politics, competition)
  [/\bnominat(?:ed|ion)\b/i,      'nomination',     1],
  [/\bprimary\b/i,                'primary',        2],
  [/\bgeneral\s+election\b/i,     'general',        3],
  [/\binaugurat(?:ed|ion)\b/i,    'inauguration',   4],
];

// Date threshold patterns
// Requires "by/before/until" to be followed by a date-like token to avoid false positives
// on score-margin phrases like "wins by over 12" or "leads by 5".
// "before/until" are always deadline prepositions; "by" is only a deadline when followed
// by a month name, year, quarter, ordinal date, or "end of".
const DATE_THRESHOLD_REGEX =
  /\b(?:before|until)\s+\S|(?:\bby\s+(?:end\s+of\s+|(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|Q[1-4]\b|\d{4}\b|\d{1,2}[\/\-]\d{1,2}))/i;

// Snapshot / on-date patterns
const ON_DATE_REGEX = /\b(?:on|at)\s+(?:the\s+)?(?:close\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\/\-]\d{1,2})/i;

// Numeric threshold patterns (cumulative "reach X")
// INDEX 0 (isReachVerb=true)  — unambiguous cumulative verbs: reach/hit/exceed/surpass/break/top
//   Allow optional parenthetical label between verb and number e.g. "hit (HIGH) $8,500".
//   Deliberately excludes "over/above": those words are overloaded — "over 2.5 goals" is a
//   binary line bet, not a monotonic threshold.
// INDEX 1 (isReachVerb=false) — directional comparators "above/over" ONLY when followed by "$"
//   so that "above $200M" is detected but "over 2.5 goals" is not.
// INDEX 2 (isReachVerb=false) — explicit "$X target/level/threshold" language.
const NUMERIC_THRESHOLD_REGEXES = [
  /\b(?:reach|hit|break|exceed|surpass|top)\s+(?:\([^)]*\)\s+)?\$?([\d,]+(?:\.\d+)?)\s*([MBK](?:illion)?(?![a-zA-Z]))?/i,
  /\b(?:above|over)\s+(?:\([^)]*\)\s+)?\$([\d,]+(?:\.\d+)?)\s*([MBK](?:illion)?(?![a-zA-Z]))?/i,
  /\$\s?([\d,]+(?:\.\d+)?)\s*([MBK](?:illion)?(?![a-zA-Z]))?\s*(?:target|level|threshold|mark|price)/i,
];

// Range patterns ("between X and Y", "from X to Y", "$X–$Y")
// The bare X-Y / X–Y form requires at least one explicit $ to avoid matching
// season notation ("2025–26") and date spans ("April 20-26").
const RANGE_REGEX = /\b(?:between\s+\$?[\d,.]+\s+(?:and|to)\s+\$?[\d,.]+|from\s+\$?[\d,.]+\s+to\s+\$?[\d,.]+|\$[\d,.]+\s*[-\u2013\u2014]\s*\$?[\d,.]+|\$?[\d,.]+\s*[-\u2013\u2014]\s*\$[\d,.]+)/i;

// Direction keywords
const DIRECTION_ABOVE_REGEX = /\b(?:above|over|exceed|reach|hit|surpass|break|top|higher\s+than|greater\s+than|at\s+least)\b/i;
const DIRECTION_BELOW_REGEX = /\b(?:below|under|beneath|lower\s+than|less\s+than|fall\s+(?:below|under|to))\b/i;

/**
 * Detect hierarchy patterns from text — pure regex, no LLM.
 * Returns null if no hierarchy pattern found.
 */
export function detectHierarchy(title: string, description: string): HierarchyResult | null {
  const text = `${title} ${description}`;

  // Check sequential series game number FIRST: "Game 1", "Game 2", "Game N".
  // Covers NBA/NFL/NHL/MLB playoff series. Must run before the tournament-round
  // loop because "Game 1 of the Finals" would otherwise be classified as
  // tournament_round/'final' rather than as a discrete sequential stage.
  const gameMatch = text.match(/\bgame\s+(\d+)\b/i);
  if (gameMatch) {
    const gameNum = parseInt(gameMatch[1], 10);
    return {
      hierarchy_type: 'sequential_stage',
      hierarchy_value: `game_${gameNum}`,
      hierarchy_level: gameNum,
    };
  }

  // Check tournament rounds (most specific → check first)
  // Iterate in reverse so more specific patterns (championship) are checked before less specific (final)
  for (let i = TOURNAMENT_LEVELS.length - 1; i >= 0; i--) {
    const [regex, value, level] = TOURNAMENT_LEVELS[i];
    if (regex.test(text)) {
      return { hierarchy_type: 'tournament_round', hierarchy_value: value, hierarchy_level: level };
    }
  }

  // Check date thresholds: "by March 2026", "before December 31"
  if (DATE_THRESHOLD_REGEX.test(title)) {
    const dateMatch = title.match(/\b(?:by|before|until)\s+([\w\s,]+\d{4})/i);
    if (dateMatch) {
      return {
        hierarchy_type: 'date_threshold',
        hierarchy_value: dateMatch[1].trim(),
        hierarchy_level: 0, // will be computed from actual dates in Stage 3
      };
    }
  }

  // Check numeric thresholds: "reach $200,000", "$200k target"
  for (const regex of NUMERIC_THRESHOLD_REGEXES) {
    const match = title.match(regex);
    if (match) {
      let value = parseFloat(match[1].replace(/,/g, ''));
      if (match[2]) {
        const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
        value *= mult[match[2].charAt(0).toUpperCase()] ?? 1;
      }
      return {
        hierarchy_type: 'numeric_threshold',
        hierarchy_value: value.toString(),
        hierarchy_level: value, // level IS the numeric value (for ordering)
      };
    }
  }

  return null;
}

/**
 * Derive condition taxonomy signals from text using regex — parallel to LLM extraction.
 * When LLM and regex agree → high confidence. When they disagree → flagged for review.
 */
export function detectConditionSignals(title: string, description: string): ConditionSignals {
  const text = `${title} ${description}`;

  let temporal_semantics: TemporalSemantics | null = null;
  if (DATE_THRESHOLD_REGEX.test(title)) {
    temporal_semantics = 'by_date';
  } else if (ON_DATE_REGEX.test(title)) {
    temporal_semantics = 'on_date';
  }

  // Shape is derived from title only — descriptions contain incidental price ranges that
  // would falsely fire RANGE_REGEX and mislabel directional/categorical markets as range_snapshot.
  let condition_shape: ConditionShape | null = null;
  if (RANGE_REGEX.test(title)) {
    // Range check first: "between X and Y" is range_snapshot regardless of cumulative keywords
    condition_shape = 'range_snapshot';
  } else {
    // Check for monotonic threshold: cumulative numeric "reach X" with a deadline
    let hasNumericThreshold = false;
    // Track whether a cumulative-verb keyword (reach/hit/exceed/…) drove the match —
    // those are inherently monotonic regardless of temporal semantics.
    let isReachVerb = false;
    for (let i = 0; i < NUMERIC_THRESHOLD_REGEXES.length; i++) {
      if (NUMERIC_THRESHOLD_REGEXES[i].test(text)) {
        hasNumericThreshold = true;
        isReachVerb = (i === 0);
        break;
      }
    }
    if (hasNumericThreshold) {
      // reach/hit/exceed verbs are inherently cumulative; also by_date makes it monotonic
      condition_shape = (temporal_semantics === 'by_date' || isReachVerb) ? 'monotonic_threshold' : 'point_in_time';
    } else if (temporal_semantics === 'by_date') {
      // By-date but no numeric threshold → event that must happen before a deadline
      condition_shape = 'cumulative_deadline';
    }
    // binary_event and categorical_outcome are not reliably detectable from title regex alone
    // (LLM handles those)
  }

  let condition_direction: ConditionDirection | null = null;
  if (RANGE_REGEX.test(text)) {
    condition_direction = 'between';
  } else if (DIRECTION_ABOVE_REGEX.test(text)) {
    condition_direction = 'above';
  } else if (DIRECTION_BELOW_REGEX.test(text)) {
    condition_direction = 'below';
  }

  return { condition_shape, condition_direction, temporal_semantics };
}
