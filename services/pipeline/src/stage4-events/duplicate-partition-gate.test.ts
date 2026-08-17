/**
 * Ω-liveness — pure classifier fixtures for the DURABLE Stage-4
 * duplicate-partition gate. Pins the Balance-of-Power + acquirer
 * topologies and confirms the classification is byte-faithful to the solver
 * belt: Arm D on cell/date/authority divergence + fold-title/⊑; the
 * nested-ladder strict-implication suppression; the distinct-KB veto.
 */
import { describe, test, expect } from 'bun:test';
import { parseCellKey as sharedParseCellKey } from '@arb/types';
import { classifyPair, parseCellKey, fold, type SlotFacts } from './duplicate-partition-gate.js';

function sf(over: Partial<SlotFacts> & { questionId: number }): SlotFacts {
  return {
    canonicalSubject: null,
    conditionDate: null,
    participants: [],
    members: [],
    ...over,
  };
}
const NO_EDGES = new Set<string>();

describe('§4.2 cellKey + fold', () => {
  test('order-invariant chamber×party; ⊥ on unparseable', () => {
    expect(parseCellKey('D House, R Senate')).toBe(parseCellKey('R Senate, D House'));
    expect(parseCellKey('D House, R Senate')).not.toBe(parseCellKey('D Senate, R House'));
    expect(parseCellKey('Anthropic')).toBeNull();
    // SWEEP EXPANSION: "<party> sweep" = party controls BOTH chambers —
    // Kalshi "Democratic sweep" and PM "Democrats sweep" must parse to the SAME
    // cellKey as the explicit two-chamber phrasing.
    expect(parseCellKey('Democratic sweep')).toBe(parseCellKey('D House, D Senate'));
    expect(parseCellKey('Democrats sweep')).toBe(parseCellKey('Democratic sweep'));
    expect(parseCellKey('Republican sweep')).toBe(parseCellKey('R House, R Senate'));
    expect(parseCellKey('Republicans sweep')).not.toBe(parseCellKey('Democrats sweep'));
    // bare 'sweep' with no party stays ⊥; sweep WITH explicit chamber keeps chamber
    expect(parseCellKey('sweep')).toBeNull();
    expect(fold('Anthropic acquired before 2027')).toBe('anthropicacquiredbefore2027');
  });

  // Full-consumption + mirror parity (durable-gate side).
  test('R2-1: false-collapse families (exactly-N / per-state / per-person) ⟹ ⊥', () => {
    // exactly-N / at-least-N seat ladders
    expect(parseCellKey('Will Democrats win exactly 9 seats in 2026 U.S. House of Representatives elections in Texas?')).toBeNull();
    expect(parseCellKey('Will the Democratic party hold exactly 55 Senate seats in the 120th Congress?')).toBeNull();
    // per-state / per-district
    expect(parseCellKey('Will D win the OH-14 House seat?')).toBeNull();
    expect(parseCellKey('Rhode Island Republican Senate Primary Winner')).toBeNull();
    // per-person
    expect(parseCellKey('Will exactly 3 the Senate Republicans lose re-election in 2026?')).toBeNull();
    expect(parseCellKey('Will Buddy Carter finish 2nd in the first round of the Georgia Republican Senate primary?')).toBeNull();
    // genuine zero-residue combo twins still parse + equate
    expect(parseCellKey('R House, D Senate')).toBe(parseCellKey('D Senate, R House'));
  });
  test('mirror parity: the durable gate re-export IS the shared @arb/types parser', () => {
    expect(parseCellKey).toBe(sharedParseCellKey);
  });
});

describe('§4.3 arms (c70 / c360 / c1520)', () => {
  test('c70 twin cells: cellKey equal + date/authority divergent ⟹ Arm D', () => {
    const a = sf({ questionId: 4322, canonicalSubject: 'D House, R Senate', members: [{ platform: 'kalshi', endDate: '2027-02-01', title: null, eventTicker: 'KXBALANCEOFPOWER-27' }] });
    const b = sf({ questionId: 4327, canonicalSubject: 'R Senate, D House', members: [{ platform: 'polymarket', endDate: '2026-11-03', title: null, eventTicker: null }] });
    const v = classifyPair(a, b, NO_EDGES, NO_EDGES);
    expect(v?.arm).toBe('D');
  });
  test('full-proof twin (same cell/date/authority) ⟹ Arm C', () => {
    const a = sf({ questionId: 1, canonicalSubject: 'D House, R Senate', members: [{ platform: 'kalshi', endDate: '2027-02-01', title: null, eventTicker: 'KXBOP-27' }] });
    const b = sf({ questionId: 2, canonicalSubject: 'R Senate, D House', members: [{ platform: 'kalshi', endDate: '2027-02-01', title: null, eventTicker: 'KXBOP-27' }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)?.arm).toBe('C');
  });
  test('c360 fold-⊑ acquirer twin ⟹ Arm D', () => {
    const a = sf({ questionId: 4411, canonicalSubject: 'Anthropic', participants: ['Anthropic'], members: [{ platform: 'polymarket', endDate: '2026-12-31', title: 'Will Anthropic be acquired before 2027?', eventTicker: null }] });
    const b = sf({ questionId: 4412, canonicalSubject: 'Anthropic acquired before 2027', participants: [], members: [{ platform: 'polymarket', endDate: '2026-12-31', title: 'Anthropic acquired 2027?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)?.arm).toBe('D');
  });
  test('F-8: distinct-KB-id ⊑ pair (trump ⊑ trumpjr) ⟹ no HIT', () => {
    const a = sf({ questionId: 1, canonicalSubject: 'Trump', participants: ['Donald Trump'], members: [{ platform: 'polymarket', endDate: null, title: 'Trump wins?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalSubject: 'Trump Jr wins primary', participants: ['Donald Trump Jr'], members: [{ platform: 'polymarket', endDate: null, title: 'Trump Jr wins?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
  test('c1520 nested ladder: strict_implication edge suppresses the fold HIT', () => {
    const title = 'Will Trump invoke the Insurrection Act during his Presidency?';
    const a = sf({ questionId: 10589, canonicalSubject: 'Before Jan 20 2029', members: [{ platform: 'kalshi', endDate: '2029-01-20', title, eventTicker: 'KXINSURRECT' }] });
    const b = sf({ questionId: 10590, canonicalSubject: 'Before 2027', members: [{ platform: 'kalshi', endDate: '2027-01-01', title, eventTicker: 'KXINSURRECT' }] });
    const strictImpl = new Set(['10589:10590']);
    expect(classifyPair(a, b, NO_EDGES, strictImpl)).toBeNull();
  });

  // Win-suffix slug twin arm.
  // DISTINCT titles so neither the fold-title nor the ⊑ arm pre-empts — ISOLATES
  // the win-suffix slug arm on the canonicalKey slugs.
  test('C2 win-suffix slug twin (rapid_vienna vs rapid_vienna_win) ⟹ Arm D', () => {
    const a = sf({ questionId: 1, canonicalKey: 'sem:5:rapid_vienna', canonicalSubject: null, participants: [], members: [{ platform: 'polymarket', endDate: null, title: 'Will Rapid Vienna win the UECL?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalKey: 'sem:5:rapid_vienna_win', canonicalSubject: null, participants: [], members: [{ platform: 'kalshi', endDate: null, title: 'Rapid Vienna to lift the trophy?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)?.arm).toBe('D');
  });
  test('C2 win-suffix veto: distinct KB entities ⟹ no HIT', () => {
    const a = sf({ questionId: 1, canonicalKey: 'sem:5:rapid_vienna', canonicalSubject: null, participants: ['Rapid Vienna'], members: [{ platform: 'polymarket', endDate: null, title: 'Will Rapid Vienna win the UECL?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalKey: 'sem:5:rapid_vienna_win', canonicalSubject: null, participants: ['Some Other Club'], members: [{ platform: 'kalshi', endDate: null, title: 'Rapid Vienna to lift the trophy?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
  test('C2 no-HIT on numeric rungs (over25 vs over35)', () => {
    const a = sf({ questionId: 1, canonicalKey: 'sem:5:over_2.5', canonicalSubject: null, participants: [], members: [{ platform: 'polymarket', endDate: null, title: 'goals?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalKey: 'sem:5:over_3.5', canonicalSubject: null, participants: [], members: [{ platform: 'kalshi', endDate: null, title: 'goals?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });

  // Person-name subset twin arm.
  // The surname-only slot ('Antonelli') is UNMERGED so it carries EMPTY participants;
  // the full-name slot ('Andrea Kimi Antonelli') carries the KB entity. Empty side ⟹
  // the distinct-KB veto is inert ⟹ Arm-D demote. Distinct titles so no fold-title/⊑ pre-empts.
  test('person-name subset twin (Antonelli ⊂ Andrea Kimi Antonelli) ⟹ Arm D', () => {
    const a = sf({ questionId: 103447005, canonicalSubject: 'Antonelli', participants: [], members: [{ platform: 'polymarket', endDate: null, title: 'Antonelli to win the GP?', eventTicker: null }] });
    const b = sf({ questionId: 103447004, canonicalSubject: 'Andrea Kimi Antonelli', participants: ['Kimi Antonelli'], members: [{ platform: 'kalshi', endDate: null, title: 'Will Andrea Kimi Antonelli win?', eventTicker: 'KXF1DRIVER-26' }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)?.arm).toBe('D');
  });
  test('person-name subset veto: distinct KB entities (Michigan vs Michigan State) ⟹ no HIT', () => {
    const a = sf({ questionId: 1, canonicalSubject: 'Michigan', participants: ['Michigan'], members: [{ platform: 'kalshi', endDate: null, title: 'Michigan to win?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalSubject: 'Michigan State Spartans', participants: ['Michigan State Spartans'], members: [{ platform: 'kalshi', endDate: null, title: 'Michigan State to win?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
  test('person-name subset: genuinely-different drivers (Hamilton vs Russell) ⟹ no HIT', () => {
    const a = sf({ questionId: 1, canonicalSubject: 'Hamilton', participants: [], members: [{ platform: 'kalshi', endDate: null, title: 'Hamilton?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalSubject: 'Russell', participants: [], members: [{ platform: 'kalshi', endDate: null, title: 'Russell?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });

  // Exact-subject value-undiscriminated cross-platform duplicate arm.
  // Distinct member titles so neither the fold-title nor the ⊑ arm pre-empts;
  // exact-equal subject (⊑ skips fa===fb).
  test('F10 both-NULL value + exact slug + equal subject ⟹ Arm D', () => {
    const a = sf({ questionId: 6747, canonicalSubject: '2028 Republican VP nominee', canonicalKey: 'sem:1:donald_trump', participants: [], members: [{ platform: 'kalshi', endDate: null, title: 'Trump for VP (Kalshi)?', eventTicker: 'KXVP-28' }] });
    const b = sf({ questionId: 6748, canonicalSubject: '2028 Republican VP nominee', canonicalKey: 'sem:2:donald_trump', participants: [], members: [{ platform: 'polymarket', endDate: null, title: 'Will Trump be the 2028 VP nominee?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)?.arm).toBe('D');
  });
  test('F10 LOAD-BEARING value gate: differing scoreline value ⟹ no HIT (set 857 Mallorca)', () => {
    const a = sf({ questionId: 171259, canonicalSubject: 'RCD Mallorca', canonicalKey: 'sem:1:m_0_0', valuePrimary: '0', valueSecondary: '0', members: [{ platform: 'kalshi', endDate: null, title: 'Mallorca 0-0?', eventTicker: null }] });
    const b = sf({ questionId: 171230, canonicalSubject: 'RCD Mallorca', canonicalKey: 'sem:2:m_1_1', valuePrimary: '1', valueSecondary: '1', members: [{ platform: 'kalshi', endDate: null, title: 'Mallorca 1-1?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
  test('F10 slug guard: donald_trump vs donald_trump_jr (KB-mislabeled participants) ⟹ no HIT', () => {
    // participants BOTH resolve to "Donald Trump" (KB fails to distinguish Trump Jr),
    // so the distinct-KB veto is inert; the EXACT-slug guard is what keeps them apart.
    const a = sf({ questionId: 6747, canonicalSubject: '2028 Republican VP nominee', canonicalKey: 'sem:1:donald_trump', participants: ['Donald Trump'], members: [{ platform: 'kalshi', endDate: null, title: 'Trump VP?', eventTicker: null }] });
    const b = sf({ questionId: 6748, canonicalSubject: '2028 Republican VP nominee', canonicalKey: 'sem:2:donald_trump_jr', participants: ['Donald Trump'], members: [{ platform: 'polymarket', endDate: null, title: 'Trump Jr VP?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
  test('F10 F-8 veto: distinct KB entities with equal subject/slug ⟹ no HIT', () => {
    const a = sf({ questionId: 1, canonicalSubject: 'Primary Winner', canonicalKey: 'sem:1:winner', participants: ['Elijah Dixon'], members: [{ platform: 'kalshi', endDate: null, title: 'Dixon?', eventTicker: null }] });
    const b = sf({ questionId: 2, canonicalSubject: 'Primary Winner', canonicalKey: 'sem:2:winner', participants: ['Jay Vaingankar'], members: [{ platform: 'polymarket', endDate: null, title: 'Vaingankar?', eventTicker: null }] });
    expect(classifyPair(a, b, NO_EDGES, NO_EDGES)).toBeNull();
  });
});
