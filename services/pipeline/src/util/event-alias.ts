/**
 * Gates a candidate event_name alias so predicate/question/value titles never
 * enter the KB alias chain. Returns [] for a non-event string, else [title].
 * Use at every event_name push site so the gate stays uniform.
 *
 * Imports only db/entity/resolvers; does not import stage1.
 */
import { looksLikePredicate, isNonEntityLabel, kbHasRealEntitySync } from '../db/entity/resolvers.js';
import { beltHit } from '../discriminators/telemetry.js';

export function gatedEventAlias(title: string | null | undefined): string[] {
  if (!title) return [];
  const t = title.trim();
  if (!t) return [];
  // A title that fold-matches a real known_entities canonical/alias is a
  // legitimate event name even when it pattern-matches the gates below. The
  // KB check is cache-only (sync); an unwarmed cache falls through to gating.
  const lp = looksLikePredicate(t);
  const nel = isNonEntityLabel(t);
  if (lp || nel) {
    if (!kbHasRealEntitySync(t)) return [];
    if (nel) beltHit('non_entity_label_kbhit');
    if (lp) beltHit('looks_predicate_kbhit');
  }
  return [t];
}
