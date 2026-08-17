/** Normalizes platform-specific scraper rows into the unified pipeline `markets` shape. */
import type { Platform } from '@arb/types';
import { parseJsonbArray } from '@arb/db';
import { classifyCategoryLabels, type UnifiedCategory } from './category-taxonomy.js';

export type GroupingType = 'threshold_series' | 'categorical_exclusive' | 'bundle_nonexclusive' | 'unknown';

// Two markets under different (non-unspecified) scopes are never equivalent.
export type ResolutionScope =
  | 'regulation'
  | 'incl_overtime'
  | 'aggregate'
  | 'unspecified';

/** Shape of the raw JSONB stored by platform scrapers */
interface RawMarketDoc {
  title?: string;
  marketTitle?: string;
  question?: string;
  description?: string;
  rules?: string;
  rules_primary?: string;
  rules_secondary?: string;
  status?: string | number;
  statusEnum?: string;
  active?: boolean;
  expired?: boolean;
  endDate?: string | Date;
  end_date?: string | Date;
  endDateIso?: string;
  cutoffAt?: number;
  close_time?: string;
  expiration_time?: string;
  expirationTimestamp?: number;
  volume?: number | string;
  volumeNum?: number;
  volume_num?: number;
  volume_fp?: string;
  volumeFormatted?: string;
  slug?: string;
  market_slug?: string;
  url?: string;
  conditionId?: string;
  condition_id?: string;
  marketId?: string | number;
  id?: string | number;
  ticker?: string;
  // Gamma API uses camelCase eventId; event_id is a legacy/fallback snake_case field.
  eventId?: string | number;
  event_id?: string;
  event_ticker?: string;
  categoryId?: number;
  categorySlug?: string;
  createdAt?: string | number | Date;
  // Polymarket grouping signals: per-child label / numeric level within a threshold series.
  groupItemTitle?: string;
  groupItemThreshold?: string;
  outcomes?: unknown[];
  resolutionSource?: string;
  category?: string;
  // true means every market sharing negRiskMarketID resolves such that exactly one is YES.
  negRisk?: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  series_ticker?: string;
  events?: unknown[];
  // Kalshi strike_type ∈ { greater, less, greater_or_equal, less_or_equal, between, custom,
  // structured, '' }; 'custom' rows carry thresholds in rules_primary prose (deriveCustomStrike()).
  strike_type?: string;
  floor_strike?: number | string;
  cap_strike?: number | string;
  yes_sub_title?: string;
  no_sub_title?: string;
  categories?: string | string[];
  tags?: string | string[];
  tradeType?: string;
  venue?: string;
  marketType?: string; // Limitless: 'single' | 'group'
  negRiskMarketId?: string; // Limitless negRisk id, lowercase d (Polymarket uses negRiskMarketID)
  markets?: unknown[]; // Limitless group: nested per-outcome sub-markets
  groupId?: number | string;
  isOther?: boolean;
  // Set by expandMarketDocs on exploded Limitless sub-markets, consumed by extractEventGrouping.
  _limitlessEventId?: string;
  _limitlessGroupingType?: GroupingType;

  tradingStatus?: string; // Predict: OPEN|CLOSED, finer-grained than `status`
  marketVariant?: string;
  categoryTitle?: string;
  resolution?: string | null;

  volumeTotalUsd?: string | number;
  volume24hUsd?: string | number;

  kalshiMarketTicker?: string;
  polymarketConditionIds?: string[];
  isNegRisk?: boolean;

  created_time?: string;
  open_time?: string;
  occurrence_datetime?: string;
  subtitle?: string;
  result?: string | null;
  volume_24h_fp?: string;

  closed?: boolean;
  archived?: boolean;
  startDate?: string | Date;
  startDateIso?: string;
  updatedAt?: string | Date;
  winningOutcome?: string;
  volume24hr?: number | string;
  liquidity?: number | string;
  expirationDate?: string;
}

// Predict's title is often a bare outcome label; builds a full question in priority order below.
function buildPredictTitle(doc: RawMarketDoc): string {
  const rawTitle    = String(doc.title ?? '').trim();
  const question    = String(doc.question ?? '').trim();
  const categoryTitle = String(doc.categoryTitle ?? '').trim();
  const variant     = String(doc.marketVariant ?? '');
  const isNegRisk   = Boolean(doc.isNegRisk);

  if (variant === 'SPORTS_MATCH' && question) return question;

  if (variant === 'SPORTS_TEAM_MATCH' && rawTitle === 'Match Winner' && question) return question;

  if (categoryTitle.includes('___') && rawTitle) {
    return categoryTitle.replace('___', rawTitle);
  }

  if (isNegRisk && categoryTitle && rawTitle) {
    return `${categoryTitle}: ${rawTitle}`;
  }

  return rawTitle || question || String(doc.marketTitle ?? '');
}

/** English month name / prefix → 0-based month index (Predict slug patterns). */
const SLUG_MONTH_IDX: Readonly<Record<string, number>> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// Uses Date.UTC (not `new Date(string)`) so the result doesn't shift with the host timezone.
function utcMidnightFromMonthName(monthName: string, day: number, year: number): Date | null {
  const idx = SLUG_MONTH_IDX[monthName.toLowerCase()];
  if (idx === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  const d = new Date(Date.UTC(year, idx, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === idx && d.getUTCDate() === day
    ? d
    : null;
}

/** Normalize a raw scraper-table JSONB row into a flat shape for the pipeline `markets` table */
export function normalizeMarketDoc(doc: RawMarketDoc, platform: Platform): {
  platform_id: string;
  title: string;
  description: string;
  status: string;
  end_date: Date | null;
  platform_created_at: Date | null;
  volume: number;
  slug: string | null;
  url: string | null;
  platform_event_id: string | null;
  grouping_type: GroupingType | null;
  category: string | null;
  category_unified: UnifiedCategory | null;
  tags: string[] | null;
  resolution_scope: ResolutionScope;
} {
  let platform_id: string;
  switch (platform) {
    case 'kalshi':
      platform_id = String(doc.ticker ?? '');
      break;
    case 'limitless':
      platform_id = String(doc.slug ?? '');
      break;
    case 'polymarket':
      platform_id = doc.conditionId ?? '';
      break;
    case 'predict':
      platform_id = String(doc.id ?? '');
      break;
  }

  const title = platform === 'predict'
    ? buildPredictTitle(doc)
    : (doc.title ?? doc.question ?? doc.marketTitle ?? '');
  const description =
    platform === 'kalshi'
      ? buildKalshiDescription(doc)
      : (doc.description ?? doc.rules ?? doc.rules_primary ?? '');
  const status = doc.statusEnum ?? String(doc.status ?? (doc.active ? 'active' : 'unknown'));

  let end_date: Date | null = null;
  const rawDate =
    doc.endDate ??
    doc.end_date ??
    doc.endDateIso ??
    doc.close_time ??
    doc.expiration_time ??
    doc.expirationTimestamp ??
    doc.cutoffAt;
  if (rawDate != null) {
    // Bare numbers are epoch-seconds if small, epoch-ms if large.
    let d: Date;
    if (typeof rawDate === 'number') {
      d = new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate);
    } else {
      d = new Date(rawDate as any);
    }
    if (!isNaN(d.getTime())) end_date = d;
  }

  // Predict has no endDate field; infer close time from categorySlug, most-precise pattern first.
  if (end_date === null && platform === 'predict' && typeof doc.categorySlug === 'string') {
    const slug = doc.categorySlug;

    const tsMatch = slug.match(/-(\d{10})(?:[^0-9]|$)/);
    if (tsMatch) {
      const d = new Date(parseInt(tsMatch[1], 10) * 1000);
      if (!isNaN(d.getTime())) end_date = d;
    }

    if (!end_date) {
      const isoMatch = slug.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);
        if (!isNaN(d.getTime())) end_date = d;
      }
    }

    if (!end_date) {
      const mdyMatch = slug.match(
        /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[- ](\d{1,2})(?:st|nd|rd|th)?[,\- ]+(\d{4})\b/i
      );
      if (mdyMatch) {
        const d = utcMidnightFromMonthName(mdyMatch[1], parseInt(mdyMatch[2], 10), parseInt(mdyMatch[3], 10));
        if (d) end_date = d;
      }
    }

    if (!end_date) {
      const mdMatch = slug.match(/-on-([a-z]+)-(\d{1,2})$/i);
      if (mdMatch) {
        const monthName = mdMatch[1];
        const day = parseInt(mdMatch[2], 10);
        const createdAt = doc.createdAt ? new Date(doc.createdAt) : new Date();
        const year = createdAt.getUTCFullYear();
        let parsed = utcMidnightFromMonthName(monthName, day, year);
        // Advance the year if the slug date is more than 6 months before createdAt.
        if (parsed) {
          if (parsed.getTime() < createdAt.getTime() - 180 * 24 * 60 * 60 * 1000) {
            parsed = utcMidnightFromMonthName(monthName, day, year + 1) ?? parsed;
          }
          end_date = parsed;
        }
      }
    }
  }

  const rawVol =
    doc.volume ??
    doc.volumeNum ??
    doc.volume_num ??
    doc.volumeTotalUsd ??
    doc.volumeFormatted ??
    doc.volume_fp ??
    0;
  const volume = typeof rawVol === 'string' ? parseFloat(rawVol) || 0 : rawVol;

  const { platform_event_id, grouping_type } = extractEventGrouping(doc, platform);

  const slug = doc.slug ?? doc.market_slug ?? null;
  const url = doc.url ?? buildMarketUrl(platform, platform_id, slug, doc) ?? null;

  const { category, tags } = extractCategoryAndTags(doc, platform);

  // For kalshi/polymarket, a post-sync step re-runs this with the parent event's category.
  const category_unified = classifyCategoryLabels([category, ...(tags ?? []), doc.title ?? '']);

  const rawCreatedAt = platform === 'kalshi' ? doc.created_time : doc.createdAt;
  let platform_created_at: Date | null = null;
  if (rawCreatedAt != null) {
    let d: Date;
    if (typeof rawCreatedAt === 'number') {
      d = new Date(rawCreatedAt < 1e12 ? rawCreatedAt * 1000 : rawCreatedAt);
    } else {
      d = new Date(rawCreatedAt as any);
    }
    if (!isNaN(d.getTime())) platform_created_at = d;
  }

  return {
    platform_id,
    title,
    description,
    status,
    end_date,
    platform_created_at,
    volume,
    slug,
    url,
    platform_event_id,
    grouping_type,
    category,
    category_unified: category_unified === 'other' ? null : category_unified,
    tags,
    resolution_scope: detectResolutionScope(title, description),
  };
}

/** Sport-default arm context; used only when the text detector returns 'unspecified', never overrides a verdict. */
export interface ScopeDefaultCtx {
  platform: Platform;
  eventKind: string | null;
  sport: string | null;
}

// Applies the sport default (soccer -> regulation, basketball -> incl_overtime) when rules text is silent.
function limitlessScopeDefault(ctx: ScopeDefaultCtx | undefined): ResolutionScope | null {
  if (!ctx || ctx.platform !== 'limitless') return null;
  if (ctx.eventKind !== 'match_winner' && ctx.eventKind !== 'championship_winner') return null;
  const sport = ctx.sport?.toLowerCase() ?? null;
  if (sport === 'soccer') return 'regulation';
  if (sport === 'basketball') return 'incl_overtime';
  return null;
}

// Requires regulation -> stoppage -> extra time in order, so it doesn't fire on an advance-method ladder.
const FULL_GAME_ENUMERATION_SRC =
  String.raw`\bregulation(?:\s+time)?\b[^.!?;]{0,20}?\bstoppage\b[^.!?;]{0,20}?\b(?:and|&)\s+(?:any\s+)?extra[ -]?time\b`;

// POSIX (Postgres ARE) mirror of FULL_GAME_ENUMERATION_SRC; keep character-identical (JS \b <-> ARE \y).
export const FULL_GAME_ENUMERATION_SQL_RX =
  `\\yregulation(\\s+time)?\\y[^.!?;]{0,20}\\ystoppage\\y[^.!?;]{0,20}\\y(and|&)\\s+(any\\s+)?extra[ -]?time\\y`;

// Stateless (no /g flag); safe to share, unlike the /g exclusion regexes below.
const INCLUSION_RX = new RegExp(
  String.raw`includ\w*\s+(any\s+)?(overtime|extra[ -]?time|ot\b|penalt|shoot-?out)|overtime period|and shootout|extra[ -]?time and penalt|including penalt|`
  + FULL_GAME_ENUMERATION_SRC,
);

// Order is most-specific first; ambiguous -> 'unspecified' (never guessed).
export function detectResolutionScope(
  title: string,
  description: string,
  ctx?: ScopeDefaultCtx,
): ResolutionScope {
  const text = `${title}\n${description}`.replace(/<[^>]+>/g, ' ').toLowerCase();

  if (/on aggregate|aggregate (score|winner)|two[- ]legged|over two legs/.test(text)) {
    return 'aggregate';
  }
  // Exclusion is checked before inclusion (inclusion patterns can match inside an exclusion
  // sentence); mixed exclusion + residual inclusion never guesses ('unspecified').
  const activeNegationRx =
    /(?:do(?:es)?\s+not|don'?t|doesn'?t|will\s+not|won'?t|not)\s+includ\w*\s+(?:any\s+)?(?:overtime|extra[ -]?time|ot\b|penalt|shoot-?out)\w*(?:[ -](?:or|and|time|periods?|shoot-?outs?|penalt\w*|overtime)\b)*/g;
  const passiveExclusionRx =
    /(?:overtime|extra[ -]?time|penalt\w*|shoot-?outs?)(?:[ -](?:or|and|time|periods?|shoot-?outs?|penalt\w*|overtime|goals?)\b)*[^.!?;,]{0,60}?(?:\bexcluded\b|\bnot\s+(?:be\s+)?(?:counted|included|considered)\b|\bdo(?:es)?\s+not\s+count\b)/g;
  const componentExceptionRx =
    /(?:\bbut\s+not|\bexcluding|\bexcept(?:ing)?)\s+(?:the\s+|any\s+)?(?:overtime|extra[ -]?time|penalt\w*|shoot-?outs?)/g;
  const inclusionRx = INCLUSION_RX;
  // Tested on the ORIGINAL text: a passive-exclusion span can swallow this evidence whole.
  const countsVoiceInclusionRx =
    /(?:overtime|extra[ -]?time|penalt\w*|shoot-?outs?)(?:(?!\b(?:not|never|no|cannot|fail(?:s|ed)?)\b|n['’]t\b)[^.!?;]){0,40}?\b(?:counts\b|count\b(?=\s+towards?\b)|(?:is|are|will\s+be)\s+counted\b)/;

  const exclusionRxs = [activeNegationRx, passiveExclusionRx, componentExceptionRx];
  const hasExclusion = exclusionRxs.some((rx) => ((rx.lastIndex = 0), rx.test(text)));
  if (hasExclusion) {
    // Exclusion + affirmative counts-voice = disagreeing components -> never guess.
    if (countsVoiceInclusionRx.test(text)) return 'unspecified';
    let residual = text;
    for (const rx of exclusionRxs) {
      rx.lastIndex = 0;
      residual = residual.replace(rx, ' ');
    }
    return inclusionRx.test(residual) ? 'unspecified' : 'regulation';
  }
  if (inclusionRx.test(text) || countsVoiceInclusionRx.test(text)) {
    return 'incl_overtime';
  }
  // Requires the progression verb tied to a round/trophy object; unanchored 'qualify'/'advance' falls to 'unspecified'.
  const knockoutRoundRx =
    /\b(?:to\s+)?(?:advance\w*|qualif(?:y|ies|ied|ication)|progress\w*|reach(?:es|ed)?|make(?:s)?\s+it)\b(?:(?!\b(?:not|never|no|fail\w*)\b|n['’]t\b)[^.!?;]){0,40}?\b(?:finals?|semi[- ]?finals?|quarter[- ]?finals?|knockout|playoffs?|next\s+round|round\s+of\s+\d+|last\s+(?:16|32|8|4)\b|conference\s+finals?|championship\s+(?:game|round|series)|the\s+(?:tie|cup|trophy|tournament))\b/;
  const trophyRx =
    /\b(?:lift(?:s|ing)?\s+the\s+trophy|win\s+the\s+(?:tie|tournament|cup|title)|hoist(?:s|ing)?\s+the\s+(?:cup|trophy))\b/;
  if (knockoutRoundRx.test(text) || trophyRx.test(text)) {
    return 'incl_overtime';
  }
  if (/end of regulation|in regulation|regular(?:ation)?\s+time|not includ\w*\s+overtime|exclud\w*\s+overtime|after 90 ?min|within 90 ?min|\b90 ?min(?:ute)?s?\b/.test(text)) {
    return 'regulation';
  }
  return limitlessScopeDefault(ctx) ?? 'unspecified';
}

// Rebuilds the same description text normalizeMarketDoc feeds detectResolutionScope, from a stored raw payload.
export function buildScopeDetectionText(platform: Platform, raw: unknown): string {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as RawMarketDoc;
  return platform === 'kalshi'
    ? buildKalshiDescription(doc)
    : String(doc.description ?? doc.rules ?? doc.rules_primary ?? '');
}

// A Limitless `marketType='group'` doc explodes into one sub-doc per outcome sharing
// platform_event_id; identity for every other platform/marketType.
export function expandMarketDocs(doc: RawMarketDoc, platform: Platform): RawMarketDoc[] {
  if (platform !== 'limitless' || doc.marketType !== 'group' || !Array.isArray(doc.markets)) {
    return [doc];
  }
  const subs = doc.markets as Array<Record<string, any>>;
  if (subs.length === 0) return [doc];

  const eventId = doc.negRiskMarketId
    ? String(doc.negRiskMarketId)
    : (subs[0]?.groupId != null ? String(subs[0].groupId) : String(doc.id ?? doc.slug ?? ''));
  if (!eventId) return [doc];

  const groupingType = limitlessGroupingType(doc, subs);
  const parentTitle = String(doc.title ?? '').trim();

  const out: RawMarketDoc[] = [];
  for (const sub of subs) {
    const subTitle = String(sub.title ?? '').trim();
    if (!sub.slug || !subTitle) continue;
    const title = parentTitle.includes('___')
      ? parentTitle.replace('___', subTitle)
      : (parentTitle ? `${parentTitle}: ${subTitle}` : subTitle);
    out.push({
      ...doc,
      slug: String(sub.slug),
      title,
      description: doc.description, // shared resolution rules live on the parent
      volume: sub.volume ?? doc.volume,
      conditionId: sub.conditionId ?? doc.conditionId,
      isOther: Boolean(sub.isOther),
      marketType: 'single', // each exploded sub is an atomic outcome
      markets: undefined,
      _limitlessEventId: eventId,
      _limitlessGroupingType: groupingType,
    });
  }
  return out.length > 0 ? out : [doc];
}

// negRisk -> categorical_exclusive; numeric "above $X" ladder -> threshold_series; else unknown.
function limitlessGroupingType(doc: RawMarketDoc, subs: Array<Record<string, any>>): GroupingType {
  // Ladder shape is tested before the negRisk check: a numeric ladder is monotonic, not mutex.
  const numericSubs = subs.filter((s) => /\d/.test(String(s.title ?? ''))).length;
  const ladderTitle = /\babove|over|reach|exceed|greater|≥|>=|\$/i.test(String(doc.title ?? ''));
  if (subs.length >= 2 && numericSubs >= subs.length * 0.6 && ladderTitle) return 'threshold_series';
  if (doc.negRiskMarketId) return 'categorical_exclusive';
  return 'unknown';
}

// category/tags are GIN-indexed; kalshi/polymarket category is populated post-sync via event join.
function extractCategoryAndTags(
  doc: RawMarketDoc,
  platform: Platform,
): { category: string | null; tags: string[] | null } {
  switch (platform) {
    case 'limitless': {
      const cats = Array.isArray(doc.categories)
        ? (doc.categories as string[])
        : (typeof doc.categories === 'string' ? [doc.categories] : []);
      const tags = Array.isArray(doc.tags)
        ? (doc.tags as string[])
        : (typeof doc.tags === 'string' ? [doc.tags] : []);
      // First non-temporal-bucket label becomes the canonical category.
      const TIME_BUCKETS = new Set(['15 min', '1 hour', 'Daily', 'Weekly', 'Monthly', 'Minutely']);
      const canonical = cats.find((c) => !TIME_BUCKETS.has(c)) ?? cats[0] ?? null;
      const combined = Array.from(new Set([...cats, ...tags])).filter(Boolean);
      return { category: canonical, tags: combined.length > 0 ? combined : null };
    }
    case 'predict': {
      const cat = doc.categorySlug ?? null;
      return { category: cat, tags: null };
    }
    case 'polymarket': {
      // Market-level category is almost always empty; the real source is the event (post-sync).
      const cat = (doc.category && doc.category.trim() !== '') ? doc.category : null;
      return { category: cat, tags: null };
    }
    case 'kalshi':
      return { category: null, tags: null };
  }
}

// Purely structural, no LLM; misclassifying a bundle as categorical_exclusive corrupts the LP solver.
function extractEventGrouping(
  doc: RawMarketDoc,
  platform: Platform,
): { platform_event_id: string | null; grouping_type: GroupingType | null } {
  switch (platform) {
    case 'predict':
      return extractPredictGrouping(doc);
    case 'polymarket':
      return extractPolymarketGrouping(doc);
    case 'kalshi':
      return extractKalshiGrouping(doc);
    case 'limitless':
      if (doc._limitlessEventId) {
        return {
          platform_event_id: `limitless:event:${doc._limitlessEventId}`,
          grouping_type: doc._limitlessGroupingType ?? 'categorical_exclusive',
        };
      }
      return { platform_event_id: null, grouping_type: null };
  }
}

function extractPredictGrouping(doc: RawMarketDoc): {
  platform_event_id: string | null; grouping_type: GroupingType | null;
} {
  // isNegRisk guarantees exactly one market in the category resolves YES; others defer to the per-event classifier.
  const eventId = doc.categoryId != null ? String(doc.categoryId) : null;
  if (!eventId) return { platform_event_id: null, grouping_type: null };
  const groupingType: GroupingType = doc.isNegRisk ? 'categorical_exclusive' : 'unknown';
  return { platform_event_id: eventId, grouping_type: groupingType };
}

function extractPolymarketGrouping(doc: RawMarketDoc): {
  platform_event_id: string | null; grouping_type: GroupingType | null;
} {
  const rawEventId = doc.eventId ?? doc.event_id ?? null;
  const eventId = rawEventId != null ? String(rawEventId) : null;
  if (!eventId) return { platform_event_id: null, grouping_type: null };

  // negRisk guarantees exactly one sibling is YES; trusted without sibling inspection.
  if (doc.negRisk === true) {
    return { platform_event_id: eventId, grouping_type: 'categorical_exclusive' };
  }

  // Multi-outcome exclusivity is native-only via negRisk above; defer to the Stage-2a reclassifier.
  const outcomes = doc.outcomes;
  const hasMultipleOutcomes = Array.isArray(outcomes) && outcomes.length > 2;
  if (hasMultipleOutcomes) {
    return { platform_event_id: eventId, grouping_type: 'unknown' };
  }

  // groupItemThreshold is a display index, not a stat/price level; defer to the Stage-2 reclassifier.
  if (doc.groupItemThreshold != null && /^[\d.\-]+$/.test(String(doc.groupItemThreshold))) {
    return { platform_event_id: eventId, grouping_type: 'unknown' };
  }

  return { platform_event_id: eventId, grouping_type: 'bundle_nonexclusive' };
}

function extractKalshiGrouping(doc: RawMarketDoc): {
  platform_event_id: string | null; grouping_type: GroupingType | null;
} {
  // A single row's title can't classify the group; authoritative classification happens post-sync.
  const eventTicker = doc.event_ticker ?? null;
  if (!eventTicker) return { platform_event_id: null, grouping_type: null };
  return {
    platform_event_id: `kalshi:event:${eventTicker}`,
    grouping_type: 'unknown',
  };
}

// None of the four platform APIs return a user-facing URL; built from the most stable identifier available.
function buildMarketUrl(
  platform: Platform,
  platformId: string,
  slug: string | null,
  doc: RawMarketDoc,
): string | null {
  switch (platform) {
    case 'kalshi': {
      // Event-level URL, not series-only, so the link points at this specific contract.
      const eventTicker = (doc.event_ticker as string | undefined) ?? platformId;
      const seriesTicker =
        (doc.series_ticker as string | undefined) ||
        eventTicker.split('-')[0] ||
        eventTicker;
      const seriesLower = seriesTicker.toLowerCase();
      const eventLower = eventTicker.toLowerCase();
      if (eventLower === seriesLower || !eventLower.startsWith(seriesLower + '-')) {
        return `https://kalshi.com/markets/${seriesLower}`;
      }
      return `https://kalshi.com/markets/${seriesLower}/${eventLower}`;
    }
    case 'polymarket': {
      const eventSlug =
        Array.isArray(doc.events) && doc.events.length > 0
          ? ((doc.events[0] as any)?.slug as string | undefined) ?? null
          : null;
      const key = eventSlug ?? slug;
      return key ? `https://polymarket.com/event/${encodeURIComponent(key)}` : null;
    }
    case 'limitless': {
      const key = slug ?? platformId;
      return key ? `https://limitless.exchange/markets/${encodeURIComponent(key)}` : null;
    }
    case 'predict': {
      return platformId ? `https://predict.fun/markets/${encodeURIComponent(platformId)}` : null;
    }
  }
}

// Prepends a compact machine-readable header of Kalshi's structured strike fields to rules_primary.
function buildKalshiDescription(doc: RawMarketDoc): string {
  const parts: string[] = [];
  const tags: string[] = [];
  if (doc.strike_type) tags.push(`kalshi:${doc.strike_type}`);
  if (doc.floor_strike != null && doc.floor_strike !== '') tags.push(`floor=${doc.floor_strike}`);
  if (doc.cap_strike != null && doc.cap_strike !== '') tags.push(`cap=${doc.cap_strike}`);
  if (doc.yes_sub_title) tags.push(`yes=${JSON.stringify(doc.yes_sub_title)}`);
  if (doc.no_sub_title) tags.push(`no=${JSON.stringify(doc.no_sub_title)}`);
  if (tags.length > 0) parts.push(`[${tags.join(' ')}]`);

  const rules = doc.rules_primary ?? doc.description ?? doc.rules ?? '';
  if (rules) parts.push(rules);
  if (doc.rules_secondary) parts.push(doc.rules_secondary);

  return parts.join('\n');
}
