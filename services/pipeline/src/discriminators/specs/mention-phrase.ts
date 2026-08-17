/**
 * Registry entry — `mention_phrase`, the mention-ladder split.
 *
 * A `speech_mention` market asks "will <SPEAKER> say <PHRASE> [N+ times]?"; the
 * phrase is the gated `outcome_label`. Different phrases are independent
 * questions, not rungs of one ladder: "People said 111+ times" does not imply
 * "Dude said 10+ times". But finalize's threshold-partition keys only on
 * (kind, metric_scope, value_unit), identical across phrases, so without this
 * spec every phrase of one event would collapse into a single monotonic
 * `threshold_series` asserting Σ=1.
 *
 * This entry adds the phrase to the set group key (finalize.ts
 * partitionThresholdGroups, scoped to speech_mention) so each phrase partitions
 * into its own ladder; a single-rung phrase then demotes to a free binary
 * question. It is also the certifier belt
 * (`belt.certifier_disc_demote.mention_phrase`): a Σ=1 verdict whose slots
 * disagree on mention_phrase is demoted to Σ≤1.
 *
 * FOLD: `assertion:'fold-key'`, `nullPolicy:'strict'` (within speech_mention: a
 * known phrase never folds with a NULL/other phrase). `kinds:['speech_mention']`
 * scopes the stamp + the set-key split; a non-mention threshold ladder carries
 * mention_phrase = NULL and never splits. `foldSurface: 'builder'` (a
 * set-partition / builder consumer, not an event-identity fragment).
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec } from '../registry.js';

const MENTION_KINDS: readonly EventKind[] = ['speech_mention'];

export const mentionPhraseSpec: DiscriminatorSpec = {
  name: 'mention_phrase',
  kinds: MENTION_KINDS,
  source: 'gated-field',
  gatedField: 'outcome_label',
  // kinds already scopes this to speech_mention rows; the extract just surfaces
  // the phrase (outcome_label). Empty label → NULL (never store '').
  extract: (ctx) => {
    const v = ctx.outcomeLabel;
    return v != null && v !== '' ? v : null;
  },
  assertion: 'fold-key',
  nullPolicy: 'strict',
  foldSurface: 'builder',
  // The phrase keys every set grouping (kinds already scopes stamps to
  // speech_mention rows; non-mention rows carry NULL -> '' key part,
  // unaffected). The bespoke outcome_label key in partitionThresholdGroups
  // stays as a belt (it also covers rows whose JSONB is empty).
  setSplit: 'all',
};
