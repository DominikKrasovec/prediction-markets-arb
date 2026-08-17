/**
 * Unit tests for `bucketSubjectOrNull` (semantic-events.ts) — the leg-persist
 * subject-hygiene gate that nulls bare count-bucket integers so they never
 * reach `questions.canonical_subject`.
 *
 * Pure function, no DB.
 */
import { describe, test, expect } from 'bun:test';
import { bucketSubjectOrNull, findSamePlatformSiblingRefusal, findHalfLineFoldRefusal, collapseSubjectTypeRows, collapseSubjectTypingRows, type SiblingLegRef, type HalfLineLegRef, type SubjectTypeRow, type SubjectTypingRow } from './semantic-events.js';
import { makeHalfLine } from '../../util/half-line.js';

describe('bucketSubjectOrNull — bare single-digit count buckets are nulled', () => {
  test('single digits (incl. whitespace-padded) → null', () => {
    for (const s of ['0', '1', '2', '3', '4', '9', ' 2 ', '\t3']) {
      expect(bucketSubjectOrNull(s)).toBeNull();
    }
  });

  test('null passes through as null', () => {
    expect(bucketSubjectOrNull(null)).toBeNull();
  });
});

describe('bucketSubjectOrNull — real subjects (incl. multi-digit & draw/tie) survive unchanged', () => {
  test('multi-digit real team names are preserved (draw-safe + 2007 invariant)', () => {
    for (const s of ['2007', '33', '180', '538', '10', '12']) {
      expect(bucketSubjectOrNull(s)).toBe(s);
    }
  });

  test('placeholder-shaped strings that are NOT single digits are untouched here', () => {
    // These are load-bearing downstream (draw machinery keys on 'Draw'/'Tie';
    // anon-slot handling reads 'Party A') — the narrow gate must NOT null them.
    for (const s of ['Draw', 'Tie', 'Party A', 'Team H', 'Other']) {
      expect(bucketSubjectOrNull(s)).toBe(s);
    }
  });

  test('ordinary named subjects survive', () => {
    for (const s of ['Joni Ernst', 'Germany', 'US Nominal GDP']) {
      expect(bucketSubjectOrNull(s)).toBe(s);
    }
  });
});

describe('bucketSubjectOrNull — A2 numeric strike/threshold labels are nulled', () => {
  test('strike/threshold labels → null (leak: se1835 unemployment-rate subjects)', () => {
    for (const s of [
      '4.0%', '4.4%', '≥4.7%', '≤3.9%', 'Above 91', 'Below 0.5%', '<0%',
      'More than $100', 'At least $700', '≥ $100', '≤ $60', '6.1% or above',
      '0.0% or below', '4 or more', '$100', '100%',
    ]) {
      expect(bucketSubjectOrNull(s)).toBeNull();
    }
  });

  test('real number-bearing entities + draw/tie stay (must NOT be nulled)', () => {
    // These are either real entities that merely contain a number, or the
    // load-bearing draw/anon subjects — the strike gate must leave them intact.
    for (const s of [
      '2007', '33', '180', '538', '500', '100 Thieves', '3M', '2K', '24/7',
      'Super Bowl LX', 'PGA Tour 2026', 'S&P 500', 'Formula 1',
      'Draw', 'Tie', 'Party A', 'Team H', 'Other',
    ]) {
      expect(bucketSubjectOrNull(s)).toBe(s);
    }
  });
});

// Set-level same-platform sibling-event refusal
const leg = (
  outcome_id: string, platform: string, pe: number | null, is_residual = false,
): SiblingLegRef => ({ outcome_id, platform, platform_event_id: pe, is_residual });

describe('findSamePlatformSiblingRefusal — the transitive set-level hole', () => {
  test('REFUSES: a new leg makes one node fed by 2 distinct same-platform pes (se-994 algeria: group-qual+RO16)', () => {
    // Prior: algeria node already fed by Kalshi pe 100 (group-qual). Incoming: the
    // charge/RO16 sibling pe 200 on the SAME node + platform.
    const existing = [leg('algeria', 'kalshi', 100), leg('argentina', 'kalshi', 100)];
    const incoming = [leg('algeria', 'kalshi', 200)];
    const c = findSamePlatformSiblingRefusal(existing, incoming);
    expect(c).not.toBeNull();
    expect(c!.outcome_id).toBe('algeria');
    expect(c!.platform).toBe('kalshi');
    expect(c!.platform_event_ids).toEqual([100, 200]);
  });

  test('ALLOWS: benign bundle — 2 same-platform pes feed DIFFERENT nodes (MLB winner+home-runs)', () => {
    // A game bundle: winner pe 10 feeds the winner node, home-runs pe 11 feeds the
    // HR node. Distinct nodes → no fungibility fusion → NOT refused.
    const existing = [leg('seattle', 'kalshi', 10), leg('houston', 'kalshi', 10)];
    const incoming = [leg('jo_adell_1plus_hr', 'kalshi', 11)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('ALLOWS: same platform_event contributing more legs to one node (normal)', () => {
    // Two markets of the SAME pe (10) on one node = one event's extra legs → fine.
    const existing = [leg('adam_schiff', 'kalshi', 10)];
    const incoming = [leg('adam_schiff', 'kalshi', 10)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('ALLOWS: cross-platform fusion on one node (that is the equivalence we WANT)', () => {
    // Kalshi arrest pe 10 + PM arrest pe 500 on the same node = the legit
    // cross-platform equivalence. Different PLATFORMS → never a same-platform sibling.
    const existing = [leg('barack_obama', 'kalshi', 10)];
    const incoming = [leg('barack_obama', 'polymarket', 500)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('EXEMPTS residual nodes (no identity — many siblings may share it)', () => {
    const existing = [leg('other', 'polymarket', 1, true)];
    const incoming = [leg('other', 'polymarket', 2, true)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('NULL-tolerant: an unknown platform_event_id is no evidence', () => {
    const existing = [leg('x', 'kalshi', null)];
    const incoming = [leg('x', 'kalshi', 200)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('does NOT blame an innocent expansion for a PRE-EXISTING collision on an untouched node', () => {
    // Node "y" is already corrupt (pes 1,2) but the new leg only touches node "z".
    const existing = [leg('y', 'kalshi', 1), leg('y', 'kalshi', 2)];
    const incoming = [leg('z', 'kalshi', 3)];
    expect(findSamePlatformSiblingRefusal(existing, incoming)).toBeNull();
  });

  test('4-pe pileup (se-1309 angers) is refused with all pes reported', () => {
    const existing = [leg('angers', 'polymarket', 337437), leg('angers', 'polymarket', 337452), leg('angers', 'polymarket', 337453)];
    const incoming = [leg('angers', 'polymarket', 40054)];
    const c = findSamePlatformSiblingRefusal(existing, incoming);
    expect(c!.platform_event_ids).toEqual([40054, 337437, 337452, 337453]);
  });
});

// collapseSubjectTypeRows: subject → KB type, canonical-priority + agree-or-null
const strow = (subj: string, type: string | null, is_canonical: boolean): SubjectTypeRow => ({ subj, type, is_canonical });

describe('findHalfLineFoldRefusal — the value-blind-fold root gate', () => {
  const leg = (outcome_id: string, hl: ReturnType<typeof makeHalfLine>, is_incoming: boolean, is_residual = false): HalfLineLegRef =>
    ({ outcome_id, is_residual, half_line: hl, is_incoming });

  test('CREATE: Kalshi ">57" (≥58) + PM "57 or more" (≥57) on one node → REFUSE', () => {
    const c = findHalfLineFoldRefusal([
      leg('above_57', makeHalfLine('above', 57, 'strict'), true),      // Kalshi tail
      leg('above_57', makeHalfLine('above', 57, 'inclusive'), true),   // PM tail
    ]);
    expect(c).not.toBeNull();
    expect(c!.outcome_id).toBe('above_57');
    expect(c!.keys.sort()).toEqual(['above:57', 'above:58']);
  });

  test('EXPANSION: incoming conflicting rung against an existing member → REFUSE', () => {
    const c = findHalfLineFoldRefusal([
      leg('n', makeHalfLine('above', 12, 'inclusive'), false),        // existing "12 or more"
      leg('n', makeHalfLine('at', 20, 'inclusive'), true),            // incoming "exactly 20"
    ]);
    expect(c).not.toBeNull();
    expect(c!.keys).toContain('at:20');
  });

  test('agreeing half-lines on one node → no refusal (legit "over 2.5" ≡ "3+")', () => {
    expect(findHalfLineFoldRefusal([
      leg('ge_3', makeHalfLine('above', 2.5, 'strict'), true),   // over 2.5 → ≥3
      leg('ge_3', makeHalfLine('above', 3, 'inclusive'), true),  // 3+ → ≥3
    ])).toBeNull();
  });

  test('conflicting lines on DIFFERENT nodes → no refusal (adjacent rungs)', () => {
    expect(findHalfLineFoldRefusal([
      leg('ge_57', makeHalfLine('above', 57, 'inclusive'), true),
      leg('ge_58', makeHalfLine('above', 58, 'inclusive'), true),
    ])).toBeNull();
  });

  test('NULL-tolerant: an unreadable member contributes no evidence', () => {
    expect(findHalfLineFoldRefusal([
      leg('n', null, true),
      leg('n', makeHalfLine('above', 57, 'inclusive'), true),
    ])).toBeNull();
  });

  test('pre-existing corruption (no incoming leg in the pair) is NOT punished', () => {
    expect(findHalfLineFoldRefusal([
      leg('n', makeHalfLine('above', 58, 'strict'), false),
      leg('n', makeHalfLine('above', 57, 'inclusive'), false),
      leg('other', makeHalfLine('above', 99, 'inclusive'), true), // innocent new leg elsewhere
    ])).toBeNull();
  });

  test('residual nodes carry no identity → exempt', () => {
    expect(findHalfLineFoldRefusal([
      leg('other', makeHalfLine('above', 58, 'strict'), true, true),
      leg('other', makeHalfLine('above', 57, 'inclusive'), true, true),
    ])).toBeNull();
  });
});

describe('collapseSubjectTypeRows', () => {
  test('canonical hit → that type', () => {
    const m = collapseSubjectTypeRows([strow('democratic party', 'organization', true)]);
    expect(m.get('democratic party')).toBe('organization');
  });

  test('alias-only hit → the aliased entity type (the un-starve case)', () => {
    // bare 'democrat' is an ALIAS of Democratic Party, not any canonical.
    const m = collapseSubjectTypeRows([strow('democrat', 'organization', false)]);
    expect(m.get('democrat')).toBe('organization');
  });

  test('canonical hit WINS over a conflicting alias hit', () => {
    // 'republican' is canonical of some person entity AND an alias of Republican Party.
    const m = collapseSubjectTypeRows([
      strow('republican', 'person', true),
      strow('republican', 'organization', false),
    ]);
    expect(m.get('republican')).toBe('person');
  });

  test('conflicting alias-only hits → null (honest abstain, guard skips)', () => {
    const m = collapseSubjectTypeRows([
      strow('other', 'team', false),
      strow('other', 'sport', false),
    ]);
    expect(m.get('other')).toBeNull();
  });

  test('agreeing alias-only hits → that type', () => {
    const m = collapseSubjectTypeRows([
      strow('gop', 'organization', false),
      strow('gop', 'organization', false),
    ]);
    expect(m.get('gop')).toBe('organization');
  });

  test('a non-null canonical type beats a null canonical collision', () => {
    const m = collapseSubjectTypeRows([
      strow('acme', null, true),
      strow('acme', 'organization', true),
    ]);
    expect(m.get('acme')).toBe('organization');
  });

  test('empty input → empty map', () => {
    expect(collapseSubjectTypeRows([]).size).toBe(0);
  });
});

// collapseSubjectTypingRows: subject → {type, role} (org-vs-politician)
const tyrow = (subj: string, type: string | null, role: string | null, is_canonical: boolean): SubjectTypingRow => ({ subj, type, role, is_canonical });

describe('collapseSubjectTypingRows', () => {
  test('canonical politician person → {person, politician}', () => {
    const m = collapseSubjectTypingRows([tyrow('janet mills', 'person', 'politician', true)]);
    expect(m.get('janet mills')).toEqual({ type: 'person', role: 'politician' });
  });
  test('alias-only org hit carries a null role → {organization, null}', () => {
    const m = collapseSubjectTypingRows([tyrow('democrat', 'organization', null, false)]);
    expect(m.get('democrat')).toEqual({ type: 'organization', role: null });
  });
  test('canonical hit WINS, carrying its role', () => {
    const m = collapseSubjectTypingRows([
      tyrow('republican', 'person', 'politician', true),
      tyrow('republican', 'organization', null, false),
    ]);
    expect(m.get('republican')).toEqual({ type: 'person', role: 'politician' });
  });
  test('conflicting alias-only types → {null, null} (abstain)', () => {
    const m = collapseSubjectTypingRows([
      tyrow('other', 'team', null, false),
      tyrow('other', 'sport', null, false),
    ]);
    expect(m.get('other')).toEqual({ type: null, role: null });
  });
  test('agreeing alias type but differing roles → role null', () => {
    const m = collapseSubjectTypingRows([
      tyrow('x', 'person', 'politician', false),
      tyrow('x', 'person', 'athlete', false),
    ]);
    expect(m.get('x')).toEqual({ type: 'person', role: null });
  });
});
