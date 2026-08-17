/**
 * Stage 3b — LLM event-match + extract.
 *
 * Drains `stage3_event_candidates` (populated by Stage 3a's ANN pass): for each
 * candidate pair, one DeepSeek call decides whether the two platform_events are
 * the same real-world event and, if so, extracts the unified outcome set + a
 * per-platform leg mapping. Deterministic guards (guards.ts) refuse to persist
 * anything unsound; valid matches land in semantic_events + _platforms + _legs.
 *
 * N-platform expansion: if either side already belongs to a semantic_event,
 * this attaches to it rather than minting a new one.
 *
 * Outcome-nodes / outcome_sets are NOT built here — that's Stage 4.
 */
import { callLLM, loadPromptTemplate, getTaskConfig, concurrencyFor } from '@arb/llm';
import { createLogger } from '@arb/logger';
import { config } from '../config.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  claimEventCandidates, getPlatformEventForMatch, getChildMarketMeta, getSubjectPartyTypings,
  findSemanticEventIdForPlatformEvent, getSemanticEventLegSubjects, persistMatch, markCandidate,
  markTransientFailure, countPendingCandidates, resetStaleInProgress,
  requeueSalvageableFailedCandidates,
  type CandidateForMatch, type PlatformEventForMatch, type LegInsert,
} from '../db/queries/semantic-events.js';
import { validateMatch, type EventMatchResult } from './guards.js';
import { nextClaimSize, checkDailyCostTripwire } from './cost-tripwire.js';

const log = createLogger('event-match');
const template = loadPromptTemplate('event-match');

// The guards in guards.ts (cross-subject over-merge backstop, period-grain
// set guard, outcome_id reconciliation, numeric YES-region leg guard, weather
// station/oracle veto, native-label leg-coherence guard) are all
// subtractive-only (drop legs / reject / re-key, never assert a merge) and
// NULL-tolerant, so they run unconditionally with no off-switch.
// Retry bound for re-arming salvageable guard-failed candidates. Default 1
// retry; STAGE3_FAILED_RETRY_MAX=0 disables the re-queue entirely.
const FAILED_RETRY_MAX = (() => {
  const n = Number(process.env.STAGE3_FAILED_RETRY_MAX ?? '1');
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
})();

export interface EventMatchStats {
  matched: number;
  expanded: number;
  skipped: number;
  failed: number;
  /** This tick stopped at STAGE3_TICK_CAP with candidates still pending. */
  capTruncated: boolean;
  /** This tick halted the LLM drain on the daily cost tripwire. */
  tripwireHalted: boolean;
}

export async function runEventMatch(
  { skipLlm = false }: { skipLlm?: boolean } = {},
): Promise<EventMatchStats> {
  const stats: EventMatchStats = {
    matched: 0, expanded: 0, skipped: 0, failed: 0, capTruncated: false, tripwireHalted: false,
  };

  if (skipLlm) {
    const pending = await countPendingCandidates();
    log.info(`--skip-llm: skipping Stage 3b event match (${pending} candidates left pending)`);
    return stats;
  }

  const reset = await resetStaleInProgress();
  if (reset > 0) log.info(`reset ${reset} stale in_progress candidates → pending`);

  // Re-arm guard-failed candidates the label-fold / phantom-demotion guards
  // can salvage (bounded by retry_count < STAGE3_FAILED_RETRY_MAX). No guard
  // is relaxed, so this is pure recall recovery.
  if (FAILED_RETRY_MAX > 0) {
    const requeued = await requeueSalvageableFailedCandidates(FAILED_RETRY_MAX);
    if (requeued > 0) {
      log.info(`re-queued ${requeued} salvageable failed candidate(s) (retry bound ${FAILED_RETRY_MAX})`);
    }
  }

  const model = getTaskConfig('event_match').model;
  const batch = config.events.matchDrainBatch;
  const conc = concurrencyFor('event_match');
  // Per-tick candidate cap + daily cost ceiling (see cost-tripwire.ts).
  const tickCap = config.events.matchTickCap;
  const dailyCostLimitUsd = config.events.dailyCostLimitUsd;

  let totalSeen = 0;
  for (;;) {
    // Daily cost tripwire: a persistent latch that stays tripped once today's
    // spend crosses STAGE3_DAILY_COST_LIMIT_USD until the UTC day rolls over.
    // Halts LLM spend only — deterministic stages keep running.
    const tw = await checkDailyCostTripwire(dailyCostLimitUsd);
    if (tw.tripped) {
      stats.tripwireHalted = true;
      log.error(
        `STAGE-3B COST TRIPWIRE TRIPPED: today's (UTC ${tw.utcDay}) DeepSeek spend ` +
        `$${tw.spentUsd.toFixed(2)} > limit $${tw.limitUsd.toFixed(2)} ` +
        `(STAGE3_DAILY_COST_LIMIT_USD) — HALTING Stage 3b LLM drain for the rest of the ` +
        `UTC day. Deterministic stages continue. Investigate a candidate re-arm (embedding ` +
        `wipe / status-reset migration / ANN-gate change) or raise the limit before resuming.`,
      );
      break;
    }

    // Bound how many candidates one tick claims so a mass re-arm cannot turn
    // a single tick into an unbounded paid drain. Remaining candidates carry
    // to the next tick.
    const claim = nextClaimSize(totalSeen, tickCap, batch);
    if (claim === 0) {
      stats.capTruncated = true;
      break;
    }

    const candidates = await claimEventCandidates(claim);
    if (candidates.length === 0) break;
    totalSeen += candidates.length;

    await mapWithConcurrency(candidates, conc, async (cand) => {
      try {
        await processCandidate(cand, model, stats);
      } catch (err) {
        log.warn(`candidate ${cand.id} errored: ${err}`);
        // A thrown error is treated as transient — re-queue under the retry
        // bound rather than terminally drop a possibly-real match.
        await markTransientFailure(cand.id, String(err)).catch(() => {});
        stats.failed++;
      }
    });
    log.info(
      `drained ${totalSeen} candidates so far ` +
      `(matched=${stats.matched} expanded=${stats.expanded} skipped=${stats.skipped} failed=${stats.failed})`,
    );
  }

  if (stats.capTruncated) {
    const pending = await countPendingCandidates();
    log.warn(
      `Stage 3b tick cap hit: drained ${totalSeen} candidates this tick ` +
      `(STAGE3_TICK_CAP=${tickCap}); ${pending} candidate(s) remain pending and will drain ` +
      `on the next tick (cap is per-tick, not a drop).`,
    );
  }

  log.info(
    `Stage 3b complete: matched=${stats.matched} expanded=${stats.expanded} ` +
    `skipped=${stats.skipped} failed=${stats.failed}` +
    (stats.capTruncated ? ' [tick-capped]' : '') +
    (stats.tripwireHalted ? ' [cost-tripwire HALTED]' : ''),
  );
  return stats;
}

async function processCandidate(
  cand: CandidateForMatch,
  model: string,
  stats: EventMatchStats,
): Promise<void> {
  const sample = config.events.childrenSampleSize;
  const [a, b] = await Promise.all([
    getPlatformEventForMatch(cand.platform_event_a, sample),
    getPlatformEventForMatch(cand.platform_event_b, sample),
  ]);
  if (!a || !b) {
    // A momentarily-missing platform_event row is transient — re-queue.
    await markTransientFailure(cand.id, 'platform_event row missing');
    stats.failed++;
    return;
  }

  const { parsed } = await callLLM<EventMatchResult>({
    task: 'event_match',
    template,
    vars: buildVars(a, b, cand.cosine_distance),
    context: { candidate_id: cand.id, pe_a: cand.platform_event_a, pe_b: cand.platform_event_b },
  });
  if (!parsed) {
    // A flaky non-JSON LLM response is transient — re-queue.
    await markTransientFailure(cand.id, 'LLM returned no JSON');
    stats.failed++;
    return;
  }

  // DeepSeek's json_object mode does not enforce numeric types, so market_id /
  // ordinal can come back as strings. Coerce at the boundary before guard +
  // persist; Number() is a no-op on numbers, and NaN stays rejected.
  for (const l of parsed.leg_mapping ?? []) {
    l.market_id = Number(l.market_id);
  }
  for (const o of parsed.outcome_set ?? []) {
    if (o.ordinal != null) o.ordinal = Number(o.ordinal);
  }

  const meta = await getChildMarketMeta([cand.platform_event_a, cand.platform_event_b]);
  const marketPlatform = new Map([...meta].map(([id, m]) => [id, m.platform] as const));
  // market_id -> internal platform_events.id, for the same-platform sibling guard.
  const marketPlatformEvent = new Map([...meta].map(([id, m]) => [id, m.platform_event_id] as const));
  const marketScope = new Map([...meta].map(([id, m]) => [id, m.resolution_scope] as const));
  // For the leg-coherence idiom bridge's cricket exclusion (test-cricket TIE != DRAW).
  const marketSport = new Map([...meta].map(([id, m]) => [id, m.sport] as const));
  const marketSubject = new Map([...meta].map(([id, m]) => [id, m.canonical_subject] as const));
  const marketEventKind = new Map([...meta].map(([id, m]) => [id, m.event_kind] as const));
  // Gates the reconciliation re-key so a period-scoped leg never collapses
  // into an overall-match slot.
  const reconcileMetricScope = new Map([...meta].map(([id, m]) => [id, (m as { metric_scope?: string | null }).metric_scope ?? null] as const));
  const marketNumeric = new Map([...meta].map(([id, m]) => [id, {
        condition_metric: m.condition_metric,
        condition_direction: m.condition_direction,
        condition_shape: m.condition_shape,
        value_primary: m.value_primary,
        value_secondary: m.value_secondary,
        value_unit: m.value_unit,
        strike_type: m.strike_type,
        floor_strike: m.floor_strike,
        cap_strike: m.cap_strike,
      }] as const));
  const marketWeather = new Map([...meta].map(([id, m]) => [id, { text: m.weather_text, subject: m.canonical_subject }] as const));
  const marketSettlementDimension = new Map([...meta].map(([id, m]) => [id, m.settlement_dimension] as const));
  // end_date is a last resort: condition_date shadows padded end_dates.
  const marketDates = new Map(
    [...meta].map(([id, m]) => [id, {
      condition_date: m.condition_date,
      condition_date_precision: m.condition_date_precision,
      end_date: m.end_date,
    }] as const),
  );
  const marketCanonicalEvent = new Map(
    [...meta].map(([id, m]) => [id, m.canonical_event] as const),
  );
  // Advance legs are unnormalized, so the title is the only rank<=2 discriminator.
  const marketTitle = new Map(
    [...meta].map(([id, m]) => [id, (m as { title?: string | null }).title ?? null] as const),
  );
  const marketKalshiSeries = new Map(
    [...meta].map(([id, m]) => [id, (m as { kalshi_series?: string | null }).kalshi_series ?? null] as const),
  );
  const marketDiscriminators = new Map(
    [...meta].map(([id, m]) => [id, m.discriminators ?? {}] as const),
  );
  const marketNativeLabel = new Map(
    [...meta].map(([id, m]) => [id, (m as { native_label?: string | null }).native_label ?? null] as const),
  );
  const marketNativeOutcomes = new Map(
    [...meta].map(([id, m]) => [id, (m as { native_outcomes?: string[] | null }).native_outcomes ?? null] as const),
  );
  // KB types of the proposed outcome subjects, for the aggregate-vs-member
  // guard (party/organization can't be an exclusive sibling of >=2 persons).
  // Only needed for categorical_exclusive.
  const subjectTypings = parsed.grouping_kind === 'categorical_exclusive'
    ? await getSubjectPartyTypings(
        (parsed.outcome_set ?? []).map((o) => (o.outcome_subject && o.outcome_subject.trim()) || o.label).filter(Boolean),
      )
    : undefined;
  const subjectType = subjectTypings
    ? new Map([...subjectTypings].map(([k, v]) => [k, v.type] as const))
    : undefined;
  const subjectParty = subjectTypings
    ? new Map([...subjectTypings].map(([k, v]) => [k, v.party] as const))
    : undefined;

  // N-platform expansion: attach to an existing semantic_event if either side
  // is already bound. Looked up before the guard so the cross-subject
  // backstop can fold the existing SE's leg subjects in — the over-merge can
  // accrete across repeated expansion merges, which a pair-local check would miss.
  const existing =
    (await findSemanticEventIdForPlatformEvent(cand.platform_event_a)) ??
    (await findSemanticEventIdForPlatformEvent(cand.platform_event_b)) ??
    undefined;
  const priorLegs = (existing && (parsed.grouping_kind === 'threshold_series' || parsed.grouping_kind === 'categorical_exclusive'))
    ? await getSemanticEventLegSubjects(existing)
    : undefined;

  const verdict = validateMatch(parsed, {
    minConfidence: config.events.minMatchConfidence,
    marketPlatform,
    marketScope,
    marketSport,
    subjectType,
    subjectParty,
    marketSubject,
    marketEventKind,
    marketNumeric,
    marketWeather,
    marketSettlementDimension,
    marketDates,
    marketNativeLabel,
    marketNativeOutcomes,
    marketCanonicalEvent,
    marketTitle,
    marketKalshiSeries,
    marketDiscriminators,
    marketPlatformEvent,
    priorLegSubjects: priorLegs?.map((l) => l.canonical_subject),
    priorLegEventKinds: priorLegs?.map((l) => l.event_kind),
    // Full prior leg-set for the union-reconciliation that rejects
    // double-mapped sum=1 slots across expansion. canonical_event is
    // deliberately not projected by getSemanticEventLegSubjects (cross-platform
    // title drift would false-block the label-fold path) and stays a defensive read.
    priorLegs: priorLegs?.map((l) => ({
      outcome_id: l.outcome_id,
      outcome_subject: l.outcome_subject,
      market_id: l.market_id,
      metric_scope: l.metric_scope ?? null,
      canonical_event: (l as { canonical_event?: string | null }).canonical_event ?? null,
      event_kind: l.event_kind ?? null,
      market_canonical_event: l.market_canonical_event ?? null,
      condition_date: l.condition_date ?? null,
      condition_date_precision: l.condition_date_precision ?? null,
      title: (l as { title?: string | null }).title ?? null,
      kalshi_series: (l as { kalshi_series?: string | null }).kalshi_series ?? null,
      platform: l.platform ?? null,
      platform_event_id: l.platform_event_id ?? null,
    })),
    reconcileMetricScope,
    newCanonicalEvent: parsed.canonical_event ?? a.title,
    reconcileEnabled: true,
  });

  if (verdict.kind === 'no_match') {
    await markCandidate(cand.id, 'skipped', `${parsed.reasoning} [${verdict.reason}]`);
    stats.skipped++;
    return;
  }
  if (verdict.kind === 'reject') {
    await markCandidate(cand.id, 'failed', `${parsed.reasoning} [${verdict.reason}]`);
    stats.failed++;
    return;
  }
  for (const w of verdict.warnings) log.warn(`candidate ${cand.id}: ${w}`);
  if (verdict.demotedNonExhaustive) {
    log.info(`candidate ${cand.id}: phantom-demoted → persisted NON-exhaustive (Σ≤1)`);
  }

  const outcomeById = new Map((parsed.outcome_set ?? []).map((o) => [o.outcome_id, o]));
  const legs: LegInsert[] = (parsed.leg_mapping ?? []).map((l) => {
    const o = outcomeById.get(l.outcome_id);
    return {
      outcome_id: l.outcome_id,
      outcome_label: o?.label ?? l.outcome_id,
      outcome_subject: o?.outcome_subject ?? null,
      outcome_ordinal: o?.ordinal ?? null,
      is_residual: o?.is_residual ?? false,
      platform: l.platform,
      market_id: l.market_id,
    };
  });

  const persistResult = await persistMatch({
    candidateId: cand.id,
    platformEventIds: [cand.platform_event_a, cand.platform_event_b],
    matchConfidence: parsed.confidence,
    legs,
    existingSemanticEventId: existing,
    semanticEvent: existing
      ? undefined
      : {
          canonical_event: parsed.canonical_event ?? a.title,
          canonical_subject: parsed.canonical_subject ?? null,
          grouping_kind: parsed.grouping_kind!,
          participants: parsed.participants ?? [],
          deadline_window: parsed.deadline_window_iso ?? null,
          confidence: parsed.confidence,
          llm_model: model,
          match_reasoning: parsed.reasoning,
        },
  });

  // Set-level same-platform sibling refusal: persistMatch declined the
  // expansion (would fuse ≥2 same-platform siblings onto one node) and already
  // marked the candidate 'skipped'. Count it as a skip, not an expansion.
  if (persistResult.refused) {
    stats.skipped++;
    return;
  }

  if (existing) stats.expanded++;
  else stats.matched++;
}

// ── Prompt var construction (renders user-template.md) ───────────────────────

function sideVars(ev: PlatformEventForMatch) {
  return {
    platform: ev.platform,
    platform_event_id: ev.platform_event_id,
    title: ev.title,
    grouping_type: ev.grouping_type,
    canonical_subject: ev.canonical_subject ?? '(unknown)',
    participants_str: ev.participants.length ? ev.participants.join(', ') : '(none listed)',
    deadline: ev.deadline ?? '(open)',
    // The authoritative game date (condition_date), not the padded `deadline`.
    // NULL -> '(open)' so the prompt does not force a date match.
    condition_date: ev.condition_date ?? '(open)',
    condition_date_precision: ev.condition_date_precision ?? '',
    total_children: ev.total_children,
    is_sampled: ev.total_children > ev.children.length,
    shown_children: ev.children.length,
    children: ev.children,
  };
}

function buildVars(a: PlatformEventForMatch, b: PlatformEventForMatch, distance: number) {
  return {
    side_a: sideVars(a),
    side_b: sideVars(b),
    ann_cosine_distance: distance.toFixed(4),
  };
}
