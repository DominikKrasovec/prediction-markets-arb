/**
 * Maps a platform's `grouping_type` onto a per-market resolution space:
 * `categorical_exclusive` -> categorical, `threshold_series` -> numeric,
 * everything else (including null) -> binary. Every individual market row
 * is still YES/NO; only categorical and numeric groups aggregate that up
 * to the event level.
 */
import type { OutcomeSpace, SyncedMarket } from '@arb/types';

export function deriveOutcomeSpace(
  groupingType: SyncedMarket['grouping_type'],
): OutcomeSpace {
  switch (groupingType) {
    case 'categorical_exclusive': return 'categorical';
    case 'threshold_series':      return 'numeric';
    case 'bundle_nonexclusive':
    case 'unknown':
    case null:
    case undefined:
      return 'binary';
  }
}
