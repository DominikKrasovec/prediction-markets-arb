/**
 * Unit suite for the one verb lexicon: classifyComparatorPhrase,
 * verbDirection, and the LEXICON_EXCEPTIONS pin table.
 *
 * Every phrase class is pinned here, including the ambiguous-context
 * resolution rules: snapshotAnchor implies snapshot; deadlineAnchor alone is
 * insufficient (stays ambiguous, resolved from the resolution source);
 * monotoneMetric prefers the snapshot stamp (touch is equivalent to terminal
 * in count domains, so the snapshot shape is stamped).
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyComparatorPhrase,
  verbDirection,
  LEXICON_EXCEPTIONS,
} from './condition-shape.js';

describe('classifyComparatorPhrase — touch verbs (doctrine rule 4 verbatim)', () => {
  test.each([
    'reach', 'reaches', 'hit', 'hits', 'exceed', 'exceeds', 'cross', 'crosses',
    'break', 'breaks', 'top', 'tops', 'surpass', 'surpasses', 'touch', 'touches',
  ])('%s → touch above', (verb) => {
    expect(classifyComparatorPhrase(verb)).toEqual({ kind: 'touch', direction: 'above' });
  });

  test.each(['dip to', 'dips', 'dip', 'fall to', 'falls to', 'drop to', 'drops to'])(
    '%s → touch below (rule 4 dip-to)',
    (verb) => {
      expect(classifyComparatorPhrase(verb)).toEqual({ kind: 'touch', direction: 'below' });
    },
  );
});

describe('classifyComparatorPhrase — settlement verbs → snapshot', () => {
  test.each([
    ['closes above', 'above'],
    ['closed below', 'below'],
    ['close above', 'above'],
    ['settles above', 'above'],
    ['settle below', 'below'],
    ['finishes week of March 30 above', 'above'], // window between verb and direction word
    ['finish week of May 11 below', 'below'],
    ['ends the month above', 'above'],
  ] as const)('%s → snapshot %s', (phrase, direction) => {
    expect(classifyComparatorPhrase(phrase)).toEqual({ kind: 'snapshot', direction });
  });
});

describe('classifyComparatorPhrase — exact-at → snapshot at', () => {
  test.each(['be at', 'at', 'be 10', 'be 3.2%'])('%s → snapshot at', (phrase) => {
    expect(classifyComparatorPhrase(phrase)).toEqual({ kind: 'snapshot', direction: 'at' });
  });
});

describe('classifyComparatorPhrase — bounded words are AMBIGUOUS without context', () => {
  test.each([
    'at least', 'or more', 'or higher', 'more than', 'greater than', 'over', '≥', '>', 'above', '120+',
  ])('%s → ambiguous above', (phrase) => {
    expect(classifyComparatorPhrase(phrase)).toEqual({ kind: 'ambiguous', direction: 'above' });
  });

  test.each([
    'at most', 'or less', 'or fewer', 'or lower', 'less than', 'fewer than', 'under', '≤', '<', 'below',
  ])('%s → ambiguous below', (phrase) => {
    expect(classifyComparatorPhrase(phrase)).toEqual({ kind: 'ambiguous', direction: 'below' });
  });
});

describe('classifyComparatorPhrase — ambiguous-context resolution', () => {
  test('snapshotAnchor resolves bounded words to snapshot (Template A dated regexes)', () => {
    expect(classifyComparatorPhrase('above', { snapshotAnchor: true }))
      .toEqual({ kind: 'snapshot', direction: 'above' });
    expect(classifyComparatorPhrase('below', { snapshotAnchor: true }))
      .toEqual({ kind: 'snapshot', direction: 'below' });
  });

  test('deadlineAnchor ALONE is INSUFFICIENT — stays ambiguous (resolve from resolution source)', () => {
    expect(classifyComparatorPhrase('above', { deadlineAnchor: true }))
      .toEqual({ kind: 'ambiguous', direction: 'above' });
    expect(classifyComparatorPhrase('or more', { deadlineAnchor: true }))
      .toEqual({ kind: 'ambiguous', direction: 'above' });
  });

  test('monotoneMetric prefers the snapshot stamp (touch is equivalent to terminal)', () => {
    expect(classifyComparatorPhrase('or more', { monotoneMetric: true }))
      .toEqual({ kind: 'snapshot', direction: 'above' });
    expect(classifyComparatorPhrase('fewer than', { monotoneMetric: true }))
      .toEqual({ kind: 'snapshot', direction: 'below' });
  });

  test('snapshotAnchor + deadlineAnchor → snapshot (the anchor wins)', () => {
    expect(classifyComparatorPhrase('above', { snapshotAnchor: true, deadlineAnchor: true }))
      .toEqual({ kind: 'snapshot', direction: 'above' });
  });

  test('context does NOT reclassify unambiguous touch verbs', () => {
    expect(classifyComparatorPhrase('reaches', { snapshotAnchor: true }))
      .toEqual({ kind: 'touch', direction: 'above' });
  });
});

describe('classifyComparatorPhrase — arrows and watermark markers → touch', () => {
  test('↑ / ↓ are touch questions', () => {
    expect(classifyComparatorPhrase('↑')).toEqual({ kind: 'touch', direction: 'above' });
    expect(classifyComparatorPhrase('↓')).toEqual({ kind: 'touch', direction: 'below' });
  });

  test('(HIGH)/(LOW) markers encode the running extremum', () => {
    expect(classifyComparatorPhrase('hit (HIGH)')).toEqual({ kind: 'touch', direction: 'above' });
    expect(classifyComparatorPhrase('hit (LOW)')).toEqual({ kind: 'touch', direction: 'below' });
    expect(classifyComparatorPhrase('hit 6.00% (Low)')).toEqual({ kind: 'touch', direction: 'below' });
    // the marker beats the embedded touch verb 'hit' for DIRECTION
    expect(classifyComparatorPhrase('hit $4.25 (HIGH)')).toEqual({ kind: 'touch', direction: 'above' });
  });
});

describe('classifyComparatorPhrase — outside the lexicon', () => {
  test.each(['', '   ', 'wins the match', 'is elected', null, undefined])('%p → null', (phrase) => {
    expect(classifyComparatorPhrase(phrase as string | null | undefined)).toBeNull();
  });
});

describe('verbDirection — the pure direction fold (replaces ~7 restated synonym lists)', () => {
  test.each([
    'above', 'over', 'higher', 'more', 'greater', 'exceeds', 'reaches', 'hits',
    'crosses', 'breaks', 'tops', 'surpasses', '>', '≥', '↑', 'HIGH',
  ])('%s → above', (w) => {
    expect(verbDirection(w)).toBe('above');
  });

  test.each([
    'below', 'under', 'lower', 'less', 'fewer', 'falls below', 'drops below',
    'dip to', 'dips', '<', '≤', '＜', '↓', 'LOW',
  ])('%s → below', (w) => {
    expect(verbDirection(w)).toBe('below');
  });

  test('below-words win when both appear (Template A fold order: "falls below")', () => {
    expect(verbDirection('falls below')).toBe('below');
    expect(verbDirection('drops below')).toBe('below');
  });

  test('unknown / null → null (callers keep their own defaults)', () => {
    expect(verbDirection('wins')).toBeNull();
    expect(verbDirection('')).toBeNull();
    expect(verbDirection(null)).toBeNull();
    expect(verbDirection(undefined)).toBeNull();
  });
});

describe('LEXICON_EXCEPTIONS — the pinned contradiction sites', () => {
  test('exactly the two remaining pinned entries, each with a >=1-char adjudication ticket', () => {
    // Ticket A1 (TOUCH, rules-text-verified) was removed; only two entries
    // remain pinned.
    expect(LEXICON_EXCEPTIONS.length).toBe(2);
    for (const e of LEXICON_EXCEPTIONS) {
      expect(e.ticket.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  test('ticket A1 adjudicated — approval hit|reach|exceed resolves TOUCH via the normal lexicon path', () => {
    expect(LEXICON_EXCEPTIONS.find((e) => e.ticket === 'A1')).toBeUndefined();
    for (const v of ['hit', 'reach', 'exceed', 'hits', 'reaches', 'exceeds']) {
      // no pin shadows the lexicon any more — the lexicon row IS the behavior
      expect(classifyComparatorPhrase(v)).toEqual({ kind: 'touch', direction: 'above' });
    }
  });

  test('ticket A2 — Limitless above-blank pinned touch (unsure, single-platform)', () => {
    const e2 = LEXICON_EXCEPTIONS.find((e) => e.ticket === 'A2')!;
    expect(e2.tag).toBe('limitless:econ-above');
    expect(e2.pinned).toBe('touch');
    expect(e2.verbs.test('above')).toBe(true);
    expect(e2.verbs.test('hit')).toBe(true);
    // lexicon says bare 'above' is ambiguous; the pin resolves it to touch
    expect(classifyComparatorPhrase('above')?.kind).toBe('ambiguous');
  });

  test('ticket O4-isPct — percent-watermark hit pinned snapshot', () => {
    const e3 = LEXICON_EXCEPTIONS.find((e) => e.tag === 'text-deterministic-A')!;
    expect(e3.pinned).toBe('snapshot');
    expect(e3.ticket).toBe('O4-isPct');
    expect(e3.verbs.test('hit')).toBe(true);
    expect(e3.verbs.test('hits')).toBe(true);
    expect(classifyComparatorPhrase('hit')?.kind).toBe('touch'); // contradiction, hence the pin
  });
});
