/**
 * Event-centric graph build — replaces the old runStage2 (hash-key grouping +
 * candidate discovery) + runStage3 (rule-engine zoo).
 *
 *   2b  ensureSingletonEvents   — wrap orphan markets in singleton platform_events
 *   2c  embedAllPlatformEvents  — event embeddings for the ANN
 *   3a  runEventAnnCandidates   — cross-platform ANN candidacy (no LLM)
 *   3b  runEventMatch           — one LLM call per candidate → semantic_events
 *   4   runStage4              — project outcome-nodes + outcome_sets + edges
 *
 * Idempotent + incremental by construction (embeds only NULL, ANN skips
 * already-enqueued pairs, the matcher drains only pending candidates). Publishes
 * graph_updated so the arb-solver reloads.
 *
 * Stage 2a (LLM classify of residual grouping_type='unknown' events) and the
 * Stage 2b LLM cluster reconstruction are deferred enhancements — the
 * deterministic path here is complete on natively-grouped + singleton events.
 */
import { publish } from '@arb/event-bus';
import { createLogger } from '@arb/logger';
import { rollupEventIdentity } from './stage2-events/rollup-event-identity.js';
import { classifyThresholdSeriesFromShapes } from './stage2-events/classify-grouping.js';
import { resolveEventIdentity, backfillFixtureParticipants, type EventIdentityStats } from './stage2-events/resolve-event-identity.js';
import { ensureSingletonEvents } from './stage2-events/reconstruct-events.js';
import { embedAllPlatformEvents } from './stage2-events/embed-events.js';
import { runEventAnnCandidates } from './stage3-events/ann-candidates.js';
import { matchCryptoCandles, type CandleMatchStats } from './stage3-events/match-candles.js';
import { confirmPairsDeterministically, type ConfirmStats } from './stage3-events/confirm-deterministic.js';
import { runEventMatch, type EventMatchStats } from './stage3-events/llm-event-match.js';
import { resetStaleInProgress } from './db/queries/semantic-events.js';
import { runStage4, type Stage4Result } from './stage4-events/finalize.js';
import { vacuumAnalyze } from './db/maintenance.js';

const log = createLogger('event-graph');

// Default-on, env-disable (reversible kill switch, like the candle pass).
const ENTITY_ON  = process.env.STAGE2A_ENTITY !== '0';
const CONFIRM_ON = process.env.DETERMINISTIC_CONFIRM !== '0';

const NO_IDENTITY: EventIdentityStats = { resolved: 0, multiSubject: 0, h2h: 0, scoped: 0 };
const NO_CONFIRM: ConfirmStats = { categorical: 0, numeric: 0, expanded: 0, rejected: 0, deferred: 0 };

export interface EventGraphResult {
  singletonEvents: number;
  identity: EventIdentityStats;
  embeddedEvents: number;
  annCandidates: number;
  candles: CandleMatchStats;
  confirm: ConfirmStats;
  match: EventMatchStats;
  stage4: Stage4Result;
}

export async function runEventGraph(
  { skipLlm = false }: { skipLlm?: boolean } = {},
): Promise<EventGraphResult> {
  log.info('Event graph build (2a → 2b → 2c → 3a → 3b → 4)…');

  const singletonEvents = await ensureSingletonEvents();
  await rollupEventIdentity();        // 2a: category + event_kind + resolution-date roll-up (gates 3a)
  await classifyThresholdSeriesFromShapes(); // 2a: classify threshold_series from normalized child shapes
  // Fill canonical_subject/participants/sport/league from native fields via
  // the KB (LLM-free) — feeds the ANN embed, the LLM prompt, and the
  // deterministic confirmer below.
  const identity = ENTITY_ON ? await resolveEventIdentity() : NO_IDENTITY;
  // Backfill real team participants onto fixture-kind events whose native
  // participants are outcome-label polluted, derived from the "A vs B" title,
  // KB-team-gated.
  if (ENTITY_ON) await backfillFixtureParticipants();
  const embeddedEvents  = await embedAllPlatformEvents();
  const annCandidates   = await runEventAnnCandidates();
  // Recover candidates a previous crashed run left `in_progress` before the
  // candle pass, so candle-pair stragglers don't leak to the LLM matcher.
  // (runEventMatch resets again; the second call is a harmless no-op.)
  const reset = await resetStaleInProgress();
  if (reset > 0) log.info(`recovered ${reset} stale in_progress candidates → pending`);
  // Deterministic crypto-candle matcher (no LLM) — drains candle candidates so
  // the LLM matcher never sees them. Runs regardless of skipLlm.
  const candles         = await matchCryptoCandles();
  // Deterministic option-set / numeric confirmation (no LLM) — confirms the
  // clean majority of candidates; only the residue reaches the LLM. Runs
  // regardless of skipLlm (it's not the LLM).
  const confirm = CONFIRM_ON ? await confirmPairsDeterministically() : NO_CONFIRM;
  const match           = await runEventMatch({ skipLlm });
  const stage4          = await runStage4();

  // Post-projection VACUUM of the heavily-churned consumer tables. Lives here
  // so every caller of the projection inherits it by construction. Stage 4's
  // finalize does churn-safe DELETE+INSERT over exactly these tables.
  // Failures are warn-and-continue inside vacuumAnalyze.
  await vacuumAnalyze([
    'questions',
    'question_members',
    'outcome_sets',
    'outcome_set_slots',
    'implication_edges',
  ]);

  const xqEdges = Object.values(stage4.crossQuestionEdges).reduce((a, b) => a + b, 0);
  publish({
    channel: 'pipeline',
    type: 'graph_updated',
    data: {
      outcome_sets_added: stage4.outcomeSets,
      edges_added: stage4.thresholdEdges + stage4.tournamentEdges + xqEdges,
    },
  }).catch(() => { /* event bus may have no clients */ });

  log.info(
    `Event graph done: ${singletonEvents} singleton events, identity{resolved=${identity.resolved} ` +
    `multi=${identity.multiSubject} h2h=${identity.h2h}}, ${embeddedEvents} embedded, ` +
    `${annCandidates} ANN candidates, candles{matched=${candles.matched} expanded=${candles.expanded} ` +
    `skipped=${candles.skipped}}, confirm{cat=${confirm.categorical} num=${confirm.numeric} ` +
    `exp=${confirm.expanded} rej=${confirm.rejected} →llm=${confirm.deferred}}, ` +
    `match{matched=${match.matched} expanded=${match.expanded} skipped=${match.skipped} failed=${match.failed}}, ` +
    `${stage4.outcomeNodes} outcome-nodes, ${stage4.outcomeSets} sets, ${stage4.thresholdEdges} ladder + ` +
    `${stage4.tournamentEdges} tournament + ${xqEdges} cross-question edges`,
  );

  return { singletonEvents, identity, embeddedEvents, annCandidates, candles, confirm, match, stage4 };
}
