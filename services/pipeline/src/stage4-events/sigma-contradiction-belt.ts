/**
 * Sigma=1 contradiction-demotion belt (Stage 4, post-certification). A belt is
 * a purely subtractive guard that re-examines an already-certified decision and
 * weakens it when the underlying facts contradict it. This one runs
 * contradiction dimensions over a certified-exhaustive set's slot facts.
 * Every dimension examines only both-known values (NULL/unknown never
 * contributes evidence) and is purely subtractive — a positive finding
 * demotes is_exhaustive to false but never deletes or rejects the set.
 */

import { isSetInertEventKind } from '@arb/types';
import { parseFixtureParticipants, countDistinctFixtures } from '../stage3-events/guards.js';
import { precisionRank, grainKeyAt } from '../util/date-grain.js';
import { conflictingOracles } from '../util/resolution-oracle-compare.js';

export interface BeltSlotFacts {
  outcome_id: string;
  canonical_events: ReadonlyArray<string>;
  condition_dates: ReadonlyArray<{ date: string; precision: string | null }>;
  event_kinds: ReadonlyArray<string>;
  resolution_sources?: ReadonlyArray<string> | undefined;
}

export interface ContradictionFinding {
  dimension: string;
  values: string[];
}

/** check() must NEVER return a finding on NULL/unknown/single-valued evidence. */
export interface ContradictionDimension {
  name: string;
  check(slots: ReadonlyArray<BeltSlotFacts>): string[] | null;
}

/** Never "united"/"city" — those DO discriminate real clubs: Dundee ≠ Dundee United. */
const ORG_DESIGNATOR_TOKENS: ReadonlySet<string> = new Set([
  'fc', 'afc', 'cf', 'cd', 'ca', 'ac', 'sc', 'ss', 'sk', 'fk', 'nk', 'hnk',
  'vfl', 'vfb', 'tsg', 'bc', 'fr', 'cs', 'cdt', 'ad', 'gv', 'ud', 'sd', 'sv',
  'bk', 'fsv', 'spvgg', 'rcd', 'rsc', 'ogc', 'losc', 'as', 'us', 'uc', 'ssd',
  'asd', 'csd', 'fbc', 'krc', 'kaa', 'sbv', 'kv', 'aek', 'psv', 'az',
  'club', 'clube', 'deportivo', 'sporting',
]);

/** Must run BEFORE participant parsing — parseFixtureParticipants' normSubject would
 *  otherwise fake a participant difference against a plain-ASCII spelling. */
function deaccent(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** null when nothing remains (an all-org name is unknown, never evidence). */
export function foldBeltParticipant(name: string): string | null {
  const tokens = deaccent(name)
    .toLowerCase()
    .replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const kept = tokens.filter((t) => !ORG_DESIGNATOR_TOKENS.has(t) && !/^\d+\.?$/.test(t));
  const base = kept.length > 0 ? kept : tokens;
  const folded = base.join('').replace(/\./g, '');
  return folded === '' ? null : folded;
}

const fixtureParticipantsDimension: ContradictionDimension = {
  name: 'fixture_participants',
  check(slots) {
    const fixtures: { participants: [string, string]; raw: string }[] = [];
    for (const s of slots) {
      for (const ce of s.canonical_events) {
        const p = parseFixtureParticipants(deaccent(ce));
        if (!p) continue; // unparseable ⇒ unknown ⇒ never evidence
        const a = foldBeltParticipant(p[0]);
        const b = foldBeltParticipant(p[1]);
        if (!a || !b) continue;
        fixtures.push({ participants: [a, b], raw: ce });
      }
    }
    if (fixtures.length < 2) return null;
    const { count, samples } = countDistinctFixtures(fixtures);
    return count >= 2 ? samples : null;
  },
};

const conditionDateDimension: ContradictionDimension = {
  name: 'condition_date',
  check(slots) {
    const dated: { date: string; precision: string | null }[] = [];
    const seen = new Set<string>();
    for (const s of slots) {
      for (const d of s.condition_dates) {
        const key = d.date + '|' + (d.precision ?? '');
        if (seen.has(key)) continue;
        seen.add(key);
        dated.push(d);
      }
    }
    if (dated.length < 2) return null;
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const rank = Math.max(precisionRank(dated[i].precision), precisionRank(dated[j].precision));
        if (grainKeyAt(dated[i].date, rank) !== grainKeyAt(dated[j].date, rank)) {
          return [dated[i].date, dated[j].date];
        }
      }
    }
    return null;
  },
};

/** Empty by design. Any entry added must be a member of the packages/types EVENT_KINDS union — a unit test pins this. */
export const ALLOWED_KIND_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [];

const eventKindDimension: ContradictionDimension = {
  name: 'event_kind',
  check(slots) {
    const kinds = new Set<string>();
    for (const s of slots) for (const k of s.event_kinds) if (!isSetInertEventKind(k)) kinds.add(k);
    if (kinds.size <= 1) return null;
    for (const fam of ALLOWED_KIND_FAMILIES) {
      let all = true;
      for (const k of kinds) if (!fam.has(k)) { all = false; break; }
      if (all) return null;
    }
    return [...kinds].sort();
  },
};

const resolutionOracleDimension: ContradictionDimension = {
  name: 'resolution_oracle',
  check(slots) {
    const all: (string | null | undefined)[] = [];
    for (const s of slots) for (const o of s.resolution_sources ?? []) all.push(o);
    return conflictingOracles(all);
  },
};

export const SIGMA1_CONTRADICTION_DIMENSIONS: ReadonlyArray<ContradictionDimension> = [
  fixtureParticipantsDimension,
  conditionDateDimension,
  eventKindDimension,
  resolutionOracleDimension,
];

/** Participants deliberately excluded: within one native platform event, canonical_event
 *  drift among children is Stage-1 label noise, not a fusion bridge. */
export const SIGMA1_NATIVE_SET_DIMENSIONS: ReadonlyArray<ContradictionDimension> = [
  conditionDateDimension,
  eventKindDimension,
  resolutionOracleDimension,
];

/** Caller demotes is_exhaustive to false when non-empty; must never delete or reject the set. */
export function sigma1Contradictions(
  slots: ReadonlyArray<BeltSlotFacts>,
  dimensions: ReadonlyArray<ContradictionDimension> = SIGMA1_CONTRADICTION_DIMENSIONS,
): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  for (const dim of dimensions) {
    const values = dim.check(slots);
    if (values !== null && values.length > 0) {
      findings.push({ dimension: dim.name, values });
    }
  }
  return findings;
}
