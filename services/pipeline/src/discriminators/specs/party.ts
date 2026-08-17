/**
 * Registry entry — `party`.
 *
 * WHAT IT LIFTS: election markets bury the PARTY in the TITLE / canonical_subject,
 * never a gated field, so every builder that folds an election race on
 * canonical_event (which is party-BLIND: '2026 ga 09 house race margin' carries no
 * party) must hand-parse the title. Live consequences the registry entry de-loads:
 *   · margin-winner.ts partyFromTitle/partyFromTicker double-belt (the extraction
 *     that orients "Republicans by ≥X ⟹ Republicans win") — belt.margin_party_titlecheck.
 *   · equivalence-edge.ts S1 opposite-party guard (R-margin ≢ D-margin of one race,
 *     both share canonical_subject/value/date) — belt.equiv_s1_party.
 *   · numeric-ladder-xq.ts election_margin EXCLUSION (party lives in title, not a
 *     gated field → can't ladder generically; the dedicated margin-ladder builder
 *     owns it).
 *
 * SOUNDNESS — both-or-neither / conflict ⇒ null. A market that mentions BOTH major
 * parties (or an intl party AND a US major, or two intl parties) is ambiguous and
 * yields no stamp — a party-agnostic absolute-margin band ('wins by ≥X points',
 * either party) must NOT be stamped, exactly mirroring margin-winner's
 * partyFromTitle both/neither→null rule. The value is a canonical lowercase party
 * token ('democratic' / 'republican' / an intl party token) so two same-party rows
 * fold together and opposite-party rows split.
 *
 * SOURCE SURFACES (scanned, conflict-aware): the market TITLE (election_margin —
 * '…margin of victory for Republicans…'), the canonical_subject (winner kinds —
 * 'Democratic Party' / 'Republican Party' is the SUBJECT), and outcome_label. The
 * regexes are exported so margin-winner.ts / equivalence-edge.ts reference the SAME
 * vocabulary (single source — the belt "reads the registry").
 *
 * fold-key / tolerant / builder-surface: party is a within-race SLICE key (like
 * metric_scope), not an event-identity key — appending it to the shared same-event
 * fragments is wrong (it does not change WHICH event resolves it). Tolerant folds
 * refuse only both-known-and-differ; a NULL side always passes (a party-blind
 * market never blocks a merge). This spec makes the value AVAILABLE (stamped at
 * Stage 1) and the generators (setDiscKey / builderDiscFoldFragment) already
 * include it.
 *
 * CATEGORICAL-SET TRAP — for the finalize setDiscKey consumer: live categorical
 * election_outcome_winner outcome_sets can have BOTH a Democratic-Party and a
 * Republican-Party slot — because for those sets the party IS the mutex OUTCOME
 * AXIS ('D wins' XOR 'R wins'), not a slice. Adding party to a CATEGORICAL set's
 * GROUP-BY key would shatter each into per-party singletons and DESTROY the
 * tradeable mutex ("KEEP categoricals whole"). party is a set-key ONLY for the
 * numeric/ladder folds where two parties are INDEPENDENT questions wrongly
 * co-folded (margin threshold_series — the margin-ladder builder already
 * separates them) and for the pairwise equivalence/ladder builders (R-margin ≢
 * D-margin). NEVER for the categorical election_outcome_winner set builder.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** US major-party token regexes (word-anchored). Exported so the Stage-4 belts
 *  reference the SAME vocabulary as the stamp (no drift). NOTE the bare 'dem'/'rep'
 *  forms from §2's illustrative regex are DELIBERATELY omitted — they match inside
 *  unrelated words ('representative', 'demand') and would mis-stamp; the full tokens
 *  below are the sound set (verified against margin-winner's anchored form). */
export const PARTY_DEM_RX = /\b(?:democrat|democrats|democratic|dems)\b/i;
export const PARTY_REP_RX = /\b(?:republican|republicans|gop)\b/i;

/** International party vocabulary → canonical lowercase token. Conservative: only
 *  unambiguous, word-anchored party names. Each distinct token folds independently;
 *  two DIFFERENT tokens present ⇒ ambiguous ⇒ null (see extractPartyToken). */
const INTL_PARTY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\blabour\b/i, 'labour'],
  [/\b(?:tory|tories|conservatives?)\b/i, 'conservative'],
  [/\blib(?:eral)? dems?\b|\bliberal democrats?\b/i, 'liberal_democrat'],
  [/\breform uk\b/i, 'reform_uk'],
  [/\bsnp\b|\bscottish national party\b/i, 'snp'],
  [/\blikud\b/i, 'likud'],
  [/\bafd\b/i, 'afd'],
];

/**
 * The canonical party token for a text blob, or null when zero OR MORE-THAN-ONE
 * distinct party is present (ambiguous → no stamp). Pure + total.
 */
export function extractPartyToken(text: string | null | undefined): string | null {
  if (!text) return null;
  const found = new Set<string>();
  if (PARTY_DEM_RX.test(text)) found.add('democratic');
  if (PARTY_REP_RX.test(text)) found.add('republican');
  for (const [rx, tok] of INTL_PARTY) if (rx.test(text)) found.add(tok);
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Extract the party discriminator from an emission row. Scans title +
 * canonical_subject + outcome_label as ONE blob so a cross-field conflict
 * (title 'Republicans' vs subject 'Democratic Party') resolves to null. The
 * winner kinds carry the party in canonical_subject ('Democratic Party'); the
 * margin/turnout kinds carry it in the title ('…for Republicans…').
 */
export function extractParty(ctx: ExtractCtx): string | null {
  const parts = [
    ctx.title,
    (ctx.gated.canonical_subject as string | null) ?? null,
    ctx.outcomeLabel,
  ].filter((s): s is string => !!s);
  return extractPartyToken(parts.join('  '));
}

const PARTY_KINDS: readonly EventKind[] = [
  'election_margin',
  'election_outcome_winner',
  'election_turnout',
  'primary_winner',
];

export const partySpec: DiscriminatorSpec = {
  name: 'party',
  kinds: PARTY_KINDS,
  source: 'title-regex',
  extract: extractParty,
  // JSONB-only — party is not a typed column; it never dual-writes.
  assertion: 'fold-key',
  nullPolicy: 'tolerant',
  foldSurface: 'builder',
  // THRESHOLD-ONLY, per the CATEGORICAL-SET TRAP above — live categorical
  // election sets carry BOTH parties as the mutex OUTCOME AXIS and must never
  // be shattered. On threshold partitions (margin ladders) two parties are
  // INDEPENDENT questions wrongly co-folded → split; this is preventive, and
  // the margin-ladder builder's title/ticker double-belt stays the active line.
  setSplit: 'threshold-only',
};
