/**
 * Pass-2 YES-region re-verification — a scoped version of the Gebele-Matthes
 * second LLM pass ("write down both markets' YES-regions over Ω explicitly,
 * then compare"), used to bound the verification false-positive rate.
 *
 * Populations:
 *   (a) ALL stage3_event_candidates with status='failed' (LLM said same-event
 *       but a deterministic guard rejected, + exhausted transients) — the
 *       re-verify AFFIRMING one of these measures the SALVAGE rate.
 *   (b) a deterministic --sample N of status='done' rows (accepted matches) —
 *       the re-verify REFUTING one of these measures the verification FP rate
 *       (the paper's <2% number). Sample order is md5('w3a-reverify-'||id) so
 *       re-runs see the same rows.
 *
 * The pass is BLIND: the prompt (packages/llm/prompts/event-reverify/) shows
 * only the two platform events + children — never the pass-1 verdict — so it
 * cannot anchor. Prompt plumbing reuses @arb/llm loadPromptTemplate/callLLM
 * with the existing `event_match` task config (same DeepSeek model/concurrency).
 *
 * Modes:
 *   DEFAULT (dry-run): NO LLM calls, NO writes. Fetches the populations,
 *     renders every prompt, prints candidate counts per failure class and the
 *     estimated token cost (chars/4 heuristic; DeepSeek prompt-cache hits on
 *     the shared system prefix make the real cost lower).
 *   --execute: actually runs the LLM calls (COSTS MONEY — see the dry-run
 *     estimate first) and computes: verification FP rate (done-pairs refuted),
 *     salvage rate (failed-pairs affirmed), per-class breakdowns. Results are
 *     written to data/exports/reverify-yes-regions-<timestamp>.json.
 *     ⚠️ --execute writes llm_logs telemetry rows (built into the shared
 *     callLLM plumbing) — it NEVER touches stage3_event_candidates or any
 *     other pipeline table.
 *
 * Usage (bun — the workspace `@arb/*` packages resolve source via the `bun`
 * export condition; plain tsx would look for unbuilt dist/):
 *   bun services/pipeline/src/scripts/reverify-yes-regions.ts                 # dry-run (default): counts + cost estimate
 *   bun services/pipeline/src/scripts/reverify-yes-regions.ts --sample 500
 *   bun services/pipeline/src/scripts/reverify-yes-regions.ts --max-failed 200
 *   bun services/pipeline/src/scripts/reverify-yes-regions.ts --execute       # runs LLM calls (cost!)
 */
import { pathToFileURL } from 'url';
import { writeFileSync } from 'fs';
import { query, endPool } from '@arb/db';
import { callLLM, loadPromptTemplate, renderPrompt, getTaskConfig, concurrencyFor, estimateCost } from '@arb/llm';
import { createLogger } from '@arb/logger';
import { config } from '../config.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  getPlatformEventForMatch, TRANSIENT_SENTINELS,
  type PlatformEventForMatch,
} from '../db/queries/semantic-events.js';

const log = createLogger('reverify-yes-regions');

// ── CLI ───────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const EXECUTE = process.argv.includes('--execute');
const SAMPLE_DONE = parseInt(argValue('--sample') ?? '200', 10);
const MAX_FAILED = argValue('--max-failed') ? parseInt(argValue('--max-failed')!, 10) : null;
/** Output-token estimate per call: two YES-region sentences + comparison JSON.
 *  Conservative; tune with --est-output-tokens after the first --execute run. */
const EST_OUTPUT_TOKENS = parseInt(argValue('--est-output-tokens') ?? '450', 10);

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** chars/4 — the standard rough tokenizer heuristic for English+JSON prompts. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Bucket a stage3_event_candidates.llm_reasoning into a failure class.
 * Guard rejects carry a trailing '[reason]' (markCandidate appends it);
 * transients are the bare sentinels. Digits and quoted strings are folded so
 * per-pair ids don't fragment the histogram.
 */
export function failureClass(reasoning: string | null): string {
  if (!reasoning) return '(no reasoning)';
  if ((TRANSIENT_SENTINELS as readonly string[]).includes(reasoning)) return `transient: ${reasoning}`;
  const m = reasoning.match(/\[([^\[\]]+)\]\s*$/);
  if (!m) return '(no guard tag)';
  const folded = m[1]
    .toLowerCase()
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+(\.\d+)?/g, '#');
  return folded.length > 90 ? `${folded.slice(0, 87)}…` : folded;
}

export interface ReverifyVerdict {
  yes_region_a: string;
  yes_region_b: string;
  relation: 'equivalent' | 'a_subset_of_b' | 'b_subset_of_a' | 'partial_overlap' | 'different_event';
  same_event: boolean;
  confidence: number;
  divergence_notes?: string | null;
  reasoning: string;
}

// ── Prompt vars (mirrors the un-exported sideVars/buildVars in llm-event-match.ts,
//    minus ann_cosine_distance — the re-verify pass is deliberately blind) ──────

function sideVars(ev: PlatformEventForMatch) {
  return {
    platform: ev.platform,
    platform_event_id: ev.platform_event_id,
    title: ev.title,
    grouping_type: ev.grouping_type,
    canonical_subject: ev.canonical_subject ?? '(unknown)',
    participants_str: ev.participants.length ? ev.participants.join(', ') : '(none listed)',
    deadline: ev.deadline ?? '(open)',
    condition_date: ev.condition_date ?? '(open)',
    condition_date_precision: ev.condition_date_precision ?? '',
    total_children: ev.total_children,
    is_sampled: ev.total_children > ev.children.length,
    shown_children: ev.children.length,
    children: ev.children,
  };
}

// ── Selection ─────────────────────────────────────────────────────────────────

interface SelectedCandidate {
  id: number;
  platform_event_a: number;
  platform_event_b: number;
  cosine_distance: number;
  llm_reasoning: string | null;
  population: 'failed' | 'done';
  cls: string;
  // filled later:
  vars?: Record<string, unknown>;
  userPrompt?: string;
  verdict?: ReverifyVerdict | null;
  error?: string;
}

async function selectCandidates(): Promise<SelectedCandidate[]> {
  const failed = await query<SelectedCandidate>(
    `SELECT id, platform_event_a, platform_event_b,
            cosine_distance::float8 AS cosine_distance, llm_reasoning
       FROM stage3_event_candidates
      WHERE status = 'failed'
      ORDER BY id
      ${MAX_FAILED !== null ? 'LIMIT $1' : ''}`,
    MAX_FAILED !== null ? [MAX_FAILED] : [],
  );
  const done = await query<SelectedCandidate>(
    `SELECT id, platform_event_a, platform_event_b,
            cosine_distance::float8 AS cosine_distance, llm_reasoning
       FROM stage3_event_candidates
      WHERE status = 'done'
      ORDER BY md5('w3a-reverify-' || id::text)
      LIMIT $1`,
    [SAMPLE_DONE],
  );
  for (const c of failed) {
    c.population = 'failed';
    c.cls = failureClass(c.llm_reasoning);
  }
  for (const c of done) {
    c.population = 'done';
    c.cls = 'done';
  }
  return [...failed, ...done];
}

// ── Main ──────────────────────────────────────────────────────────────────────

const template = loadPromptTemplate('event-reverify');

function printClassTable(cands: SelectedCandidate[]): void {
  const byClass = new Map<string, number>();
  for (const c of cands.filter((x) => x.population === 'failed')) {
    byClass.set(c.cls, (byClass.get(c.cls) ?? 0) + 1);
  }
  console.log('\n=== failed-population breakdown by guard/failure class ===');
  console.table(
    [...byClass.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, n]) => ({ class: cls, n })),
  );
}

async function main(): Promise<void> {
  const model = getTaskConfig('event_match').model;
  log.info(
    `mode: ${EXECUTE ? 'EXECUTE (LLM calls — costs money; telemetry rows land in llm_logs)' : 'DRY-RUN (no LLM calls, no writes)'} ` +
    `| model=${model} | done sample=${SAMPLE_DONE}${MAX_FAILED !== null ? ` | failed cap=${MAX_FAILED}` : ''}`,
  );

  const cands = await selectCandidates();
  const nFailed = cands.filter((c) => c.population === 'failed').length;
  const nDone = cands.filter((c) => c.population === 'done').length;
  log.info(`selected ${cands.length} candidates: ${nFailed} failed (all) + ${nDone} done (sampled)`);
  printClassTable(cands);

  // Render every prompt (needed for the cost estimate; reused by --execute).
  let unfetchable = 0;
  await mapWithConcurrency(cands, 8, async (c) => {
    const sample = config.events.childrenSampleSize;
    const [a, b] = await Promise.all([
      getPlatformEventForMatch(c.platform_event_a, sample),
      getPlatformEventForMatch(c.platform_event_b, sample),
    ]);
    if (!a || !b) {
      unfetchable++;
      return;
    }
    c.vars = { side_a: sideVars(a), side_b: sideVars(b) };
    c.userPrompt = renderPrompt(template.userTemplate, c.vars);
  });
  const renderable = cands.filter((c) => c.userPrompt);
  if (unfetchable > 0) log.warn(`${unfetchable} candidates reference a missing platform_event — skipped`);

  // ── Cost estimate (always printed) ──────────────────────────────────────────
  const systemTokens = estimateTokens(template.systemPrompt);
  const inputTokens = renderable.reduce((sum, c) => sum + systemTokens + estimateTokens(c.userPrompt!), 0);
  const outputTokens = renderable.length * EST_OUTPUT_TOKENS;
  const cost = estimateCost(model, inputTokens, outputTokens);
  console.log('\n=== token / cost estimate ===');
  console.table([
    {
      calls: renderable.length,
      'input tokens (est)': inputTokens,
      'output tokens (est)': outputTokens,
      [`cost USD (est, ${model})`]: `$${cost.toFixed(2)}`,
      'avg input tok/call': renderable.length ? Math.round(inputTokens / renderable.length) : 0,
    },
  ]);
  console.log('(input est = chars/4 incl. the shared system prompt each call; DeepSeek prompt-cache hits on the system prefix will lower the real cost)');

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete — no LLM calls made. Re-run with --execute to run the re-verification.');
    return;
  }

  // ── Execute ─────────────────────────────────────────────────────────────────
  const conc = concurrencyFor('event_match');
  log.info(`executing ${renderable.length} re-verification calls (concurrency ${conc})…`);
  let doneCalls = 0;
  await mapWithConcurrency(renderable, conc, async (c) => {
    try {
      const { parsed } = await callLLM<ReverifyVerdict>({
        task: 'event_match', // reuse the Stage-3b provider/model/maxTokens config
        template,            // event-reverify prompt (loaded above)
        vars: c.vars!,
        context: { script: 'reverify-yes-regions', candidate_id: c.id, population: c.population },
      });
      c.verdict = parsed ?? null;
    } catch (err) {
      c.error = String(err);
    } finally {
      doneCalls++;
      if (doneCalls % 100 === 0) log.info(`…${doneCalls}/${renderable.length} calls done`);
    }
  });

  summarizeExecution(renderable, model);
}

function summarizeExecution(cands: SelectedCandidate[], model: string): void {
  const judged = cands.filter((c) => c.verdict);
  const errored = cands.filter((c) => c.error);
  const noJson = cands.filter((c) => !c.verdict && !c.error);

  const done = judged.filter((c) => c.population === 'done');
  const failed = judged.filter((c) => c.population === 'failed');
  const refuted = done.filter((c) => c.verdict!.same_event === false);
  const affirmed = failed.filter(
    (c) => c.verdict!.same_event === true && c.verdict!.confidence >= config.events.minMatchConfidence,
  );

  console.log('\n=== execution summary ===');
  console.table([
    { metric: 'calls judged', value: judged.length },
    { metric: 'calls errored', value: errored.length },
    { metric: 'calls no-JSON', value: noJson.length },
    { metric: 'done sampled & judged', value: done.length },
    { metric: 'done REFUTED (pass-2 says different_event)', value: refuted.length },
    { metric: 'verification FP rate (paper <2%)', value: done.length ? `${((100 * refuted.length) / done.length).toFixed(2)}%` : 'n/a' },
    { metric: 'failed judged', value: failed.length },
    { metric: 'failed AFFIRMED (salvageable)', value: affirmed.length },
    { metric: 'salvage rate', value: failed.length ? `${((100 * affirmed.length) / failed.length).toFixed(2)}%` : 'n/a' },
  ]);

  console.log('\n=== relation breakdown ===');
  const relations = ['equivalent', 'a_subset_of_b', 'b_subset_of_a', 'partial_overlap', 'different_event'] as const;
  console.table(
    relations.map((r) => ({
      relation: r,
      done: done.filter((c) => c.verdict!.relation === r).length,
      failed: failed.filter((c) => c.verdict!.relation === r).length,
    })),
  );

  console.log('\n=== salvage by failure class ===');
  const byClass = new Map<string, { total: number; affirmed: number }>();
  for (const c of failed) {
    const e = byClass.get(c.cls) ?? { total: 0, affirmed: 0 };
    e.total++;
    if (affirmed.includes(c)) e.affirmed++;
    byClass.set(c.cls, e);
  }
  console.table(
    [...byClass.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([cls, e]) => ({ class: cls, total: e.total, affirmed: e.affirmed })),
  );

  const outPath = `data/exports/reverify-yes-regions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model,
        executed_at: new Date().toISOString(),
        results: cands.map((c) => ({
          candidate_id: c.id,
          population: c.population,
          failure_class: c.cls,
          cosine_distance: c.cosine_distance,
          verdict: c.verdict ?? null,
          error: c.error ?? null,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nfull per-candidate results written to ${outPath}`);
}

const isMain =
  process.argv[1] != null &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  main()
    .catch((err) => {
      log.error('fatal:', err);
      process.exitCode = 1;
    })
    .finally(() => endPool());
}
