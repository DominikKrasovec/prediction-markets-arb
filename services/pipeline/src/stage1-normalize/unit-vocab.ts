/**
 * Shared emission-side `value_unit` canonicalization. Stage-4 gates compare
 * value_unit strictly, so every deterministic norm must funnel through
 * {@link canonicalUnit} to avoid unit-string drift blocking a same-event edge.
 * Distinct metrics are never cross-folded; the sport-dependent remaps below
 * are the sound exceptions, gated so an unknown sport is never guessed.
 */

export interface UnitContext {
  sport?: string | null;
  league?: string | null;
  eventKind?: string | null;
  metric?: string | null;
  /** TRUE only when the handler guessed the unit from magnitude, not an explicit title noun. */
  unitInferred?: boolean;
}

/** Mass/measure/marker units + currencies that must not be pluralized (currencies stay uppercase). */
const KEEP_AS_IS: Record<string, string> = {
  usd: 'USD',
  jpy: 'JPY',
  krw: 'KRW',
  eur: 'EUR',
  gbp: 'GBP',
  percent: 'percent',
  'percentage points': 'percentage points',
  bps: 'bps',
  rank: 'rank',
  score: 'score',
  ratio: 'ratio',
  fahrenheit: 'fahrenheit',
  celsius: 'celsius',
  index_value: 'index_value',
  count: 'count',
  pick: 'pick',
  team: 'team',
  league: 'league',
  teams_remaining: 'teams_remaining',
  hits_runs_rbis: 'hits_runs_rbis',
  homes_millions: 'homes_millions',
};

/** Only sports whose spread unit is unambiguous; anything else keeps the handler's unit. */
const SPORT_NATURAL_SPREAD_UNIT: Record<string, string> = {
  soccer: 'goals',
  basketball: 'points',
  'american football': 'points',
  baseball: 'runs',
  'ice hockey': 'goals',
  cricket: 'runs',
};

/** 'maps'/'games'/'sets'/'strokes' are deliberately absent — different ladder dimensions. */
const GENERIC_SCORE_UNITS = new Set(['point', 'points', 'goal', 'goals', 'run', 'runs']);

export function isSportRemappableSpreadUnit(unit: string): boolean {
  return GENERIC_SCORE_UNITS.has(unit.trim().toLowerCase());
}

/** Deliberately baseball-only: other sports' low-value totals are ambiguous with
 *  playoff series-length markets, so remapping them could fold a series total into a score total. */
const SPORT_NATURAL_TOTAL_UNIT: Record<string, string> = {
  baseball: 'runs',
};

/** 'games' is eligible only because the unitInferred gate proves the title had no explicit noun. */
const TOTAL_REMAP_ELIGIBLE = new Set([...GENERIC_SCORE_UNITS, 'game', 'games']);

export function isSportRemappableTotalUnit(unit: string): boolean {
  return TOTAL_REMAP_ELIGIBLE.has(unit.trim().toLowerCase());
}

/** Sport fallback when ctx.sport is null but the league resolved. Lowercase keys. */
const LEAGUE_SPORT: Record<string, string> = {
  nba: 'basketball',
  wnba: 'basketball',
  ncaab: 'basketball',
  nfl: 'american football',
  ufl: 'american football',
  ncaaf: 'american football',
  mlb: 'baseball',
  kbo: 'baseball',
  npb: 'baseball',
  nhl: 'ice hockey',
  ipl: 'cricket',
  epl: 'soccer',
  'premier league': 'soccer',
  'la liga': 'soccer',
  'serie a': 'soccer',
  bundesliga: 'soccer',
  'ligue 1': 'soccer',
  mls: 'soccer',
  'champions league': 'soccer',
  'europa league': 'soccer',
  'liga mx': 'soccer',
  eredivisie: 'soccer',
  'a-league': 'soccer',
  'efl championship': 'soccer',
  'fa cup': 'soccer',
  'k league': 'soccer',
  'j league': 'soccer',
  'saudi pro league': 'soccer',
  'scottish premiership': 'soccer',
  'copa do brasil': 'soccer',
  'brasileirão': 'soccer',
  brasileirao: 'soccer',
};

const IRREGULAR_PLURAL: Record<string, string> = {
  tornado: 'tornadoes',
  inch: 'inches',
};

function pluralize(unit: string): string {
  const irregular = IRREGULAR_PLURAL[unit];
  if (irregular) return irregular;
  if (/s$/.test(unit)) return unit;
  if (/(ch|sh|x|z)$/.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

/** Never returns null; falls back to lowercase-pluralized when nothing in the table applies. */
export function canonicalUnit(rawUnit: string, ctx: UnitContext = {}): string {
  const trimmed = rawUnit.trim();
  if (!trimmed) return rawUnit;

  const folded = trimmed.toLowerCase();
  const keep = KEEP_AS_IS[folded];
  if (keep !== undefined) return keep;
  if (/^[A-Z]{3}$/.test(trimmed)) return trimmed;

  let unit = folded;
  if (ctx.eventKind === 'match_spread' && GENERIC_SCORE_UNITS.has(unit)) {
    const sport =
      ctx.sport?.toLowerCase() ??
      (ctx.league ? LEAGUE_SPORT[ctx.league.toLowerCase()] : undefined) ??
      null;
    const natural = sport ? SPORT_NATURAL_SPREAD_UNIT[sport] : undefined;
    if (natural) unit = natural;
  }
  // Both gates load-bearing: unitInferred (title had no unit noun) AND a SPORT_NATURAL_TOTAL_UNIT row.
  if (
    ctx.eventKind === 'match_total_metric' &&
    ctx.unitInferred === true &&
    TOTAL_REMAP_ELIGIBLE.has(unit)
  ) {
    const sport =
      ctx.sport?.toLowerCase() ??
      (ctx.league ? LEAGUE_SPORT[ctx.league.toLowerCase()] : undefined) ??
      null;
    const natural = sport ? SPORT_NATURAL_TOTAL_UNIT[sport] : undefined;
    if (natural) unit = natural;
  }
  return pluralize(unit);
}

/** In-place canonicalization; when the unit changes, condition_value and canonical_event
 *  are suffix-rewritten too so a norm never carries a unit its own condition_value disagrees with. */
export function canonicalizeNormUnit(
  norm: {
    value_unit?: string | null;
    condition_value?: string | null;
    canonical_event?: string | null;
    event_kind?: string | null;
    condition_metric?: string | null;
  },
  ctx: Pick<UnitContext, 'sport' | 'league'> = {},
): void {
  const old = norm.value_unit;
  if (!old) return;
  const next = canonicalUnit(old, {
    sport: ctx.sport ?? null,
    league: ctx.league ?? null,
    eventKind: norm.event_kind ?? null,
    metric: norm.condition_metric ?? null,
  });
  if (next === old) return;

  norm.value_unit = next;
  if (norm.condition_value && norm.condition_value.endsWith(old)) {
    norm.condition_value = norm.condition_value.slice(0, -old.length) + next;
  }
  // Scoped to the player-prop branch's exact preconditions so a fixture name is never rewritten.
  if (
    norm.event_kind === 'player_prop_threshold' &&
    norm.condition_metric === 'count' &&
    norm.canonical_event &&
    norm.canonical_event.endsWith(` ${old}`)
  ) {
    norm.canonical_event = norm.canonical_event.slice(0, -old.length) + next;
  }
}

export const __TEST__ = {
  KEEP_AS_IS,
  SPORT_NATURAL_SPREAD_UNIT,
  SPORT_NATURAL_TOTAL_UNIT,
  GENERIC_SCORE_UNITS,
  TOTAL_REMAP_ELIGIBLE,
  LEAGUE_SPORT,
  IRREGULAR_PLURAL,
};
