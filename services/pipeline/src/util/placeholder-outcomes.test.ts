/**
 * Unit tests for the Ω (outcome-node) placeholder detector `placeholderSlotsInSet`.
 *
 * This guards the soundness-critical drop applied at Stage 4 finalize
 * (buildPlatformOutcomeSets / buildSemanticOutcomeSets): a placeholder slot left in a
 * `categorical` one-hot manufactures a fake arb, but dropping a REAL slot ALSO
 * manufactures one. The asymmetry (over-keeping safe, over-dropping a bug) is why the
 * detector is anchored on the BARE label, single-letter alpha, sequence-aware, and
 * residual-preserving. Every test below pins one of those properties against a live
 * data shape that motivated the design.
 */
import { describe, test, expect } from 'bun:test';
import {
  placeholderSlotsInSet,
  isFixturePlaceholderSubject,
  FIXTURE_PLACEHOLDER_SUBJECT_SQL_RX,
} from './placeholder-outcomes.js';

/** Build {id,label} children from bare labels (id = 1-based index). */
function set(labels: (string | null)[]) {
  return labels.map((label, i) => ({ id: i + 1, label }));
}
function classify(labels: (string | null)[]) {
  const { drop, residual } = placeholderSlotsInSet(set(labels));
  return {
    drop: [...drop].sort((a, b) => a - b),
    residual: [...residual].sort((a, b) => a - b),
  };
}

describe('placeholderSlotsInSet — series detection', () => {
  test('drops a placeholder series, keeps the named outcome (≥2 distinct indices)', () => {
    // labels 1,2 = "Candidate D/F" series; 3 = real name.
    expect(classify(['Candidate D', 'Candidate F', 'Jane Smith'])).toEqual({ drop: [1, 2], residual: [] });
  });

  test('numeric indices form a series too (Cyprus "Party NN")', () => {
    expect(classify(['Party 21', 'Party 23', 'DISY', 'AKEL'])).toEqual({ drop: [1, 2], residual: [] });
  });

  test('mixed named + full A..O placeholder field (Illinois governor shape)', () => {
    const r = classify(['Democrat', 'Republican', 'Option A', 'Option B', 'Option C', 'Other']);
    expect(r.drop).toEqual([3, 4, 5]); // Option A/B/C
    expect(r.residual).toEqual([6]); // "Other"
  });
});

describe('placeholderSlotsInSet — lone survives (the soundness guard)', () => {
  test('a lone "Team A" with no sibling series is KEPT', () => {
    // The key correctness gate: a single <noun> <index> might be a real entity.
    expect(classify(['Team A', 'Real Madrid'])).toEqual({ drop: [], residual: [] });
  });

  test('a lone "Team A" alongside many real clubs is KEPT (Coppa Italia shape)', () => {
    expect(classify(['Atalanta', 'Inter', 'Lazio', 'Como', 'Team A', 'Other'])).toEqual({
      drop: [],
      residual: [6],
    });
  });
});

describe('placeholderSlotsInSet — residual classification', () => {
  test('flags "Other" as residual, never dropped', () => {
    expect(classify(['Option C', 'Option G', 'Other'])).toEqual({ drop: [1, 2], residual: [3] });
  });

  test('recognizes "the field" and noun-qualified "another ..." residuals', () => {
    const r = classify(['Player A', 'Player B', 'the field']);
    expect(r.drop).toEqual([1, 2]);
    expect(r.residual).toEqual([3]);
    expect(classify(['Party A', 'Party B', 'another party']).residual).toEqual([3]);
  });

  test('FIX ⑤/Predict: bare "Draw"/"Tie" + full-title "ends in a draw/tie" are residual; "Drew" is NOT', () => {
    // A fixture's draw leg is its native residual — completes home/away → keeps Σ=1.
    expect(classify(['Arsenal', 'Chelsea', 'Draw']).residual).toEqual([3]);
    expect(classify(['Real Madrid', 'Barcelona', 'Tie']).residual).toEqual([3]);
    // Predict ships the draw leg as a full title, not a bare label.
    expect(
      classify(['Will Arsenal win?', 'Will Chelsea win?', 'Will the match end in a draw?']).residual,
    ).toEqual([3]);
    // Anchored bare-label form keeps real names safe: "Drew …" must NOT be residual.
    expect(classify(['Drew Barrymore', 'Jane Smith']).residual).toEqual([]);
  });

  test('a real outcome merely STARTING with "Another" is NOT residual (regression: bare ^another)', () => {
    // Live case: a Limitless threshold ladder with NULL bare labels falls back to its
    // titles, all of which start with "Another". A bare /^another\b/ classified all three
    // as residual → realCount 0 → the whole monotonic ladder was wrongly demoted.
    const titles = [
      'Another crypto hack over $100M by June 30, 2026?',
      'Another crypto hack over $100M by September 30, 2026?',
      'Another crypto hack over $100M by December 31, 2026?',
    ];
    const { drop, residual } = placeholderSlotsInSet(titles.map((t, i) => ({ id: i + 1, label: t })));
    expect([...drop]).toEqual([]); // not a placeholder series
    expect([...residual]).toEqual([]); // and NOT residual → set survives with 3 real slots
  });
});

describe('placeholderSlotsInSet — false-positive guards (real entities must survive)', () => {
  test('2-letter index is a real abbreviation, not a slot ("Team GB"/"Team SA")', () => {
    // Team A/B are a series (single-letter), but Team GB/SA survive (2-letter).
    expect(classify(['Team A', 'Team B', 'Team GB', 'Team SA'])).toEqual({ drop: [1, 2], residual: [] });
  });

  test('noun as a SUFFIX of a real name is not a slot ("Labour Party 25%+")', () => {
    // Anchored on the whole label → "Labour Party 25%+" does not START with the noun.
    expect(classify(['Labour Party 25%+', 'Labour Party 15-20%', 'Labour Party 5-10%'])).toEqual({
      drop: [],
      residual: [],
    });
  });

  test('award titles do not misfire ("...PFA Player of the Year" labels are real names)', () => {
    // Real PFA award: bare labels are player names; the "Player A".."Player B" slots
    // are the only placeholders. (A full-TITLE scan would match "Player of" and drop
    // every real candidate — exactly the bug this anchoring prevents.)
    const r = classify(['Declan Rice', 'Erling Haaland', 'Player A', 'Player B', 'Other']);
    expect(r.drop).toEqual([3, 4]);
    expect(r.residual).toEqual([5]);
  });

  test('dropped vocab words are not treated as slots (car|horse|side|entry)', () => {
    expect(classify(['Car 1', 'Car 2', 'Horse A', 'Horse B'])).toEqual({ drop: [], residual: [] });
  });

  test('null / empty / whitespace labels are ignored', () => {
    expect(classify(['Option A', 'Option B', null, '', '   '])).toEqual({ drop: [1, 2], residual: [] });
  });
});

describe('placeholderSlotsInSet — feeds the finalize demote gate', () => {
  test('an all-placeholder set leaves <2 real survivors (finalize then demotes the set)', () => {
    // 2 placeholders + 1 residual → kept = {residual}, real = 0 < 2 → caller demotes.
    const { drop, residual } = placeholderSlotsInSet(set(['Fighter A', 'Fighter B', 'Other']));
    const realKept = [1, 2, 3].filter((id) => !drop.has(id) && !residual.has(id));
    expect([...drop].sort()).toEqual([1, 2]);
    expect([...residual]).toEqual([3]);
    expect(realKept.length).toBe(0); // < 2 real → finalize drops the whole outcome_set
  });

  test('works with string ids (feed-A outcome_id representation)', () => {
    const { drop, residual } = placeholderSlotsInSet([
      { id: 'o1', label: 'Candidate D' },
      { id: 'o2', label: 'Candidate F' },
      { id: 'o3', label: 'Jane Smith' },
      { id: 'o4', label: 'Other' },
    ]);
    expect([...drop].sort()).toEqual(['o1', 'o2']);
    expect([...residual]).toEqual(['o4']);
  });
});

describe('isFixturePlaceholderSubject (P3 — Brewers cd5ad701518b class)', () => {
  test('recognizes every fixture delimiter form', () => {
    for (const s of [
      'Brewers vs. Cubs',
      'Milwaukee Brewers vs Chicago Cubs',
      'Chiefs @ Eagles',
      'Arsenal – Chelsea',
      'Arsenal — Chelsea',
      'Wolverhampton - Nottingham Forest',
      'Alcaraz v. Sinner',
      'Alcaraz v Sinner',
    ]) {
      expect(isFixturePlaceholderSubject(s)).toBe(true);
    }
  });

  test('real entity names survive (over-refusing costs recall, but a club name is not a fixture)', () => {
    for (const s of [
      'Real Madrid',
      'V-Varen Nagasaki', // delimiter must be space-DELIMITED on both sides
      'Jean-Luc Picard',
      'Bayer 04 Leverkusen',
      'Vancouver Whitecaps FC',
      'Draw',
      'Team A',
    ]) {
      expect(isFixturePlaceholderSubject(s)).toBe(false);
    }
  });

  test('NULL / blank is FALSE (absent ≠ fixture-shaped; NULL has its own ban)', () => {
    expect(isFixturePlaceholderSubject(null)).toBe(false);
    expect(isFixturePlaceholderSubject(undefined)).toBe(false);
    expect(isFixturePlaceholderSubject('   ')).toBe(false);
    expect(isFixturePlaceholderSubject('vs.')).toBe(false); // no flanks
    expect(isFixturePlaceholderSubject('Brewers vs.')).toBe(false);
  });

  test('whitespace is normalised before matching', () => {
    expect(isFixturePlaceholderSubject('  Brewers   vs.   Cubs  ')).toBe(true);
  });

  test('SQL twin agrees with the TS predicate on every fixture above (no drift)', () => {
    // POSIX \s/\S are the same classes JS uses here, so the SQL body is directly
    // executable as a JS RegExp — the invariant is literal string equality of behaviour.
    const sqlAsJs = new RegExp(FIXTURE_PLACEHOLDER_SUBJECT_SQL_RX, 'i');
    const yes = ['Brewers vs. Cubs', 'Chiefs @ Eagles', 'Arsenal – Chelsea', 'Alcaraz v Sinner'];
    const no = ['Real Madrid', 'V-Varen Nagasaki', 'Team A', 'Draw'];
    for (const s of yes) {
      expect(sqlAsJs.test(s)).toBe(true);
      expect(isFixturePlaceholderSubject(s)).toBe(true);
    }
    for (const s of no) {
      expect(sqlAsJs.test(s)).toBe(false);
      expect(isFixturePlaceholderSubject(s)).toBe(false);
    }
  });
});

describe('placeholderSlotsInSet — feed-A underscore slug + person noun (2026-06-06)', () => {
  // Feed A passes the outcome_id SLUG ('option_a'/'fighter_b' — underscore, lowercase),
  // not the spaced label feed B uses. The detector normalises [_-] → space so the
  // anchored regex catches both forms.
  test('underscore-slug placeholder series is dropped', () => {
    expect(classify(['option_a', 'option_b', 'option_c', 'option_d'])).toEqual({ drop: [1, 2, 3, 4], residual: [] });
  });

  test('mixed underscore placeholders + a real name', () => {
    expect(classify(['fighter_a', 'fighter_b', 'Conor McGregor'])).toEqual({ drop: [1, 2], residual: [] });
  });

  test('a LONE underscore placeholder is still kept (sequence-aware)', () => {
    const r = classify(['option_a', 'Jane Smith', 'other']);
    expect(r.drop).toEqual([]);
    expect(r.residual).toEqual([3]); // 'other' normalised → matched as residual
  });

  test("'person' noun is now a placeholder stem (WV/RI Senate 'Person A'..'Person C')", () => {
    const r = classify(['Democratic Party', 'Republican Party', 'Person A', 'Person B', 'Person C']);
    expect(r.drop).toEqual([3, 4, 5]);
  });
});

describe('SQL twins stay byte-locked to their TS sources (P3/P11)', () => {
  test('OMEGA_SLOT_SQL_RX is byte-identical to the TS slot regex source', async () => {
    // The negRisk completeness COUNT (finalize) nets out placeholder slots with this
    // POSIX twin; a drift here would silently change which markets count as real.
    const { OMEGA_SLOT_SQL_RX, isOmegaPlaceholderSlot } = await import('./placeholder-outcomes.js');
    const asJs = new RegExp(OMEGA_SLOT_SQL_RX, 'i');
    for (const s of ['Team A', 'Player 12', 'party b']) {
      expect(asJs.test(s)).toBe(true);
      expect(isOmegaPlaceholderSlot(s)).toBe(true);
    }
    for (const s of ['Team GB', 'Real Madrid', 'Labour Party 25%+']) {
      expect(asJs.test(s)).toBe(false);
      expect(isOmegaPlaceholderSlot(s)).toBe(false);
    }
  });

  test('the SQL boolean helpers are COALESCE-guarded (a NULL column is FALSE, never NULL)', async () => {
    const { isFixturePlaceholderSubjectSql, isOmegaPlaceholderSlotSql } = await import(
      './placeholder-outcomes.js'
    );
    const a = isFixturePlaceholderSubjectSql('q.canonical_subject');
    expect(a).toContain('COALESCE(');
    expect(a).toContain(', FALSE)');
    expect(a).toContain('~*'); // case-insensitive POSIX match
    const b = isOmegaPlaceholderSlotSql('m.title');
    expect(b).toContain('COALESCE(');
    expect(b).toContain(', FALSE)');
    // slug normalisation must mirror the TS ([_-] → space) so 'option_a' matches
    expect(b).toContain("regexp_replace(m.title, '[_-]+', ' ', 'g')");
  });
});
