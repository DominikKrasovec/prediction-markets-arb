/**
 * Registry entry — `extremum`.
 *
 * The half-line orientation of a "reach/hit $X" market — whether the
 * settlement touches an upper half-line (`above`) or a lower one (`below`).
 * Stage-1 already stamps this as the typed `condition_direction` column.
 * `reach-threshold-chain` derives `dir` field-first (COALESCE(stamped,
 * title-derived)); a title regex reading a watermark like "(LOW)" is demoted
 * to a cross-check belt, so a new watermark idiom resolves to the sound
 * field rather than a reversed chain.
 *
 * Fold: `assertion:'fold-key'`, `nullPolicy:'strict'`. `foldSurface:'builder'`
 * because the consumer is the reach-chain builder, not an event-identity
 * fragment — appending condition_direction to the shared same-event
 * fragments would false-split mixed-direction slices.
 */
import type { DiscriminatorSpec } from '../registry.js';

export const extremumSpec: DiscriminatorSpec = {
  name: 'extremum',
  kinds: 'all', // condition_direction is a gated column present across kinds; the
                // stamp is a pure mirror, so 'all' cannot change any typed column.
  source: 'gated-field',
  gatedField: 'condition_direction',
  extract: (ctx) => {
    const v = ctx.gated['condition_direction'];
    return typeof v === 'string' && v !== '' ? v : null;
  },
  assertion: 'fold-key',
  nullPolicy: 'strict',
  foldSurface: 'builder',
};
