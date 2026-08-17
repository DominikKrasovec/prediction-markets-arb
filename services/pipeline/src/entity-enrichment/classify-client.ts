/**
 * Async entity classifier client — calls the spaCy sidecar for batch entity
 * type classification, falling back to the local regex classifier when the
 * sidecar is unreachable so the pipeline is never blocked on it.
 *
 * Deterministic sport_canonical / league_canonical resolution from Polymarket
 * tag slugs and Limitless metadata happens in worker.ts after this call,
 * independently of whether the sidecar was reachable.
 *
 * Env vars:
 *   NER_SIDECAR_URL — base URL of the sidecar (default http://localhost:8765)
 *   NER_SIDECAR_TIMEOUT_MS — per-request timeout in ms (default 8000)
 */

import { classifyEntity, type EntityContext, type EntityClassification } from './entity-heuristic.js';
import { createLogger } from '@arb/logger';

const log = createLogger('classify-client');

const SIDECAR_URL = (process.env.NER_SIDECAR_URL ?? 'http://localhost:8765').replace(/\/$/, '');
const TIMEOUT_MS  = parseInt(process.env.NER_SIDECAR_TIMEOUT_MS ?? '8000');

let _sidecarWarnedDown = false;
let _sidecarConfirmedUp = false;

interface SidecarResult {
  type: string;
  sport_hint: string | null;
  league_canonical: string | null;
  notes: string[];
  source: 'spacy' | 'heuristic';
}

interface SidecarBatchResponse {
  results: SidecarResult[];
}

/**
 * Returns results in the same order as `contexts`, each tagged with a
 * `source` field ('spacy' | 'heuristic').
 */
async function classifyBatch(contexts: EntityContext[]): Promise<(EntityClassification & { source: 'spacy' | 'heuristic' })[]> {
  if (contexts.length === 0) return [];

  if (_sidecarWarnedDown) {
    return contexts.map((ctx) => ({ ...classifyEntity(ctx), source: 'heuristic' as const }));
  }

  try {
    const response = await fetch(`${SIDECAR_URL}/ner/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entities: contexts.map((c) => ({
          canonical:       c.canonical,
          aliases:         c.aliases,
          domain_category: c.domain_category,
          current_type:    c.current_type,
          sample_titles:   c.sample_titles,
        })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as SidecarBatchResponse;

    if (!Array.isArray(data.results) || data.results.length !== contexts.length) {
      throw new Error(`unexpected response shape (got ${data.results?.length} results for ${contexts.length} inputs)`);
    }

    if (!_sidecarConfirmedUp) {
      log.info(`spaCy sidecar confirmed at ${SIDECAR_URL}`);
      _sidecarConfirmedUp = true;
      _sidecarWarnedDown = false;
    }

    return data.results.map((r) => ({
      entity_type:       r.type as EntityClassification['entity_type'],
      sport_canonical:   r.sport_hint,
      league_canonical:  r.league_canonical,
      notes:             r.notes,
      source:            'spacy' as const,
    }));
  } catch (err) {
    if (!_sidecarWarnedDown) {
      log.warn(`spaCy sidecar unavailable (${err}); falling back to local classifier for this session.`);
      _sidecarWarnedDown = true;
      _sidecarConfirmedUp = false;
    }
    return contexts.map((ctx) => ({ ...classifyEntity(ctx), source: 'heuristic' as const }));
  }
}

