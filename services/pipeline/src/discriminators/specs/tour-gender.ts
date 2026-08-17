/**
 * Discriminates men's vs women's tennis tournaments (championship_winner +
 * match_winner only; a no-op stamp elsewhere), since titles carry no tour
 * token. Wraps stage1-normalize/tennis-tour.ts.
 *
 * nullPolicy `block-when-sibling-known` is tolerant at Stage-4 folds (a NULL
 * side never blocks a merge); the Stage-3 leg-coherence belt separately drops
 * a NULL-tour leg fusing with a sibling whose tour is known.
 *
 * Uses its own native value (title + canonical_event tour token), never
 * league_id: per-team KB league tags are unreliable, so a blanket
 * both-known league-equality gate would false-kill sound fixture edges.
 *
 * source is title-regex plus a native-metadata arm: the Kalshi series ticker
 * suffix and `raw.rules_primary` prose feed the same tennis-context-gated,
 * null-on-doubt weak-signal tiers as the title regex.
 */
import type { EventKind } from '@arb/types';
import { deriveTennisTour } from '../../stage1-normalize/tennis-tour.js';
import type { DiscriminatorSpec } from '../registry.js';

const TOUR_GENDER_KINDS: readonly EventKind[] = ['championship_winner', 'match_winner'];

export const tourGenderSpec: DiscriminatorSpec = {
  name: 'tour_gender',
  kinds: TOUR_GENDER_KINDS,
  source: 'title-regex',
  extract: (ctx) =>
    deriveTennisTour({
      title: ctx.title,
      // canonical_event carries the tour qualifier on both platforms.
      eventTitle: (ctx.gated.canonical_event as string | null) ?? null,
      eventTicker: typeof ctx.raw?.event_ticker === 'string' ? ctx.raw.event_ticker : null,
      rulesPrimary: typeof ctx.raw?.rules_primary === 'string' ? ctx.raw.rules_primary : null,
    }),
  assertion: 'fold-key',
  nullPolicy: 'block-when-sibling-known',
  foldSurface: 'builder',
};
