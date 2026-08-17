import { describe, test, expect } from 'bun:test';
import { normalizeEventNoun, normalizeFixtureCanonicalEvent, yearFromIso, deriveCanonicalEventCore, fixtureSubjectOverride } from './event-name-normalizer.js';

describe('DW-10/DW-11 fixtureSubjectOverride (combined-total & BTTS fixture-subjecting gate)', () => {
  const fixture = 'Brazil vs Morocco';

  // combined totals (metric_scope != 'team') re-subject to the fixture.
  test('total, game scope → fixture subject', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'match_total_metric', metricScope: 'game', participantCount: 2, canonicalEvent: fixture,
    })).toBe(fixture);
  });
  test('total, NULL scope (whole match) → fixture subject', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'match_total_metric', metricScope: null, participantCount: 2, canonicalEvent: fixture,
    })).toBe(fixture);
  });
  test('total, period/series scopes → fixture subject', () => {
    for (const scope of ['first_5', 'half_1', 'half_2', 'map', 'series', 'set']) {
      expect(fixtureSubjectOverride({
        eventKind: 'match_total_metric', metricScope: scope, participantCount: 2, canonicalEvent: fixture,
      })).toBe(fixture);
    }
  });

  // SOUNDNESS caveat: per-TEAM totals KEEP the team subject — overriding
  // those manufactures false merges.
  test('total, team scope → unchanged (null)', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'match_total_metric', metricScope: 'team', participantCount: 2, canonicalEvent: fixture,
    })).toBeNull();
  });

  // BTTS is symmetric → fixture subject.
  test('both_teams_score → fixture subject', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'both_teams_score', metricScope: null, participantCount: 2, canonicalEvent: fixture,
    })).toBe(fixture);
  });

  // SOUNDNESS: never touches winner-oriented kinds — exact_score's team
  // subject is load-bearing for winner orientation.
  test('exact_score → unchanged (null)', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'exact_score', metricScope: null, participantCount: 2, canonicalEvent: fixture,
    })).toBeNull();
  });
  test('match_winner → unchanged (null)', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'match_winner', metricScope: null, participantCount: 2, canonicalEvent: fixture,
    })).toBeNull();
  });

  // Guard rails: no fixture to merge onto → keep the subject.
  test('<2 participants → unchanged (null)', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'match_total_metric', metricScope: null, participantCount: 1, canonicalEvent: fixture,
    })).toBeNull();
  });
  test('empty/NULL canonical_event → unchanged (null)', () => {
    expect(fixtureSubjectOverride({
      eventKind: 'both_teams_score', metricScope: null, participantCount: 2, canonicalEvent: '',
    })).toBeNull();
    expect(fixtureSubjectOverride({
      eventKind: 'match_total_metric', metricScope: null, participantCount: 2, canonicalEvent: null,
    })).toBeNull();
  });
});

describe('AUD-13 fixture-symmetric canonical_event (subject NOT a participant: totals/BTTS/draw)', () => {
  const base = {
    eventKind: 'match_total_metric',
    conditionShape: 'monotonic_threshold',
    conditionMetric: null,
    valueUnit: 'goals',
    rawCanonicalEvent: 'morocco vs brazil totals',
    canonicalSubject: 'Brazil vs Morocco', // fixture-string subject
    canonicalParticipants: ['Brazil', 'Morocco'],
    categoryUnified: 'sports',
    eventDateIso: '2026-06-13',
  };

  test('fixture-subjected total → alphabetized KB-name event (same key match_winner uses)', () => {
    expect(deriveCanonicalEventCore(base)).toBe('Brazil vs Morocco');
  });
  test('participant order is irrelevant (alphabetized)', () => {
    expect(deriveCanonicalEventCore({ ...base, canonicalParticipants: ['Morocco', 'Brazil'] })).toBe('Brazil vs Morocco');
  });
  test('draw (subject=Draw, 2 participants) co-locates on the same fixture as the winner nodes', () => {
    expect(deriveCanonicalEventCore({
      ...base, eventKind: 'match_winner', conditionShape: 'binary_event', valueUnit: null, canonicalSubject: 'Draw',
    })).toBe('Brazil vs Morocco');
  });
  test('different fixtures do NOT collide', () => {
    const other = deriveCanonicalEventCore({
      ...base, canonicalSubject: 'Argentina vs France', canonicalParticipants: ['Argentina', 'France'],
    });
    expect(other).toBe('Argentina vs France');
    expect(other).not.toBe('Brazil vs Morocco');
  });
  test('keep-bespoke: H2H winner (subject IS a participant, opponents.length===1) unaffected', () => {
    expect(deriveCanonicalEventCore({
      ...base, eventKind: 'match_winner', conditionShape: 'binary_event', canonicalSubject: 'Brazil',
    })).toBe('Brazil vs Morocco');
  });
  test('SOUNDNESS: non-sports 2-participant does NOT get the fixture key', () => {
    expect(deriveCanonicalEventCore({
      ...base, categoryUnified: 'politics', rawCanonicalEvent: 'some senate race', canonicalSubject: 'Field',
    })).not.toBe('Brazil vs Morocco');
  });
});

describe('AUD-14-B competition-noun aliasing (golf major / tennis grand slam merge key)', () => {
  test('golf major: bare Predict form → "<year> major"', () => {
    expect(normalizeEventNoun('Will Scottie Scheffler win a major in 2026?', 2026)).toBe('2026 major');
  });
  test('golf major: no explicit year + yearHint', () => {
    expect(normalizeEventNoun('Will Rory McIlroy win a major?', 2026)).toBe('2026 major');
  });
  test('golf major: qualified variants (PGA / PGA Tour / golf) collapse to bare "major"', () => {
    expect(normalizeEventNoun('Will X win a PGA Tour major in 2026?', 2026)).toBe('2026 major');
    expect(normalizeEventNoun('Will X win a PGA major in 2026?', 2026)).toBe('2026 major');
    expect(normalizeEventNoun('Will X win a golf major in 2026?', 2026)).toBe('2026 major');
  });
  test('golf major: Predict and Kalshi forms converge on the same key', () => {
    const predict = normalizeEventNoun('Will Scottie Scheffler win a major in 2026?', 2026);
    const kalshi = normalizeEventNoun('Will X win a PGA major in 2026?', 2026);
    expect(predict).toBe(kalshi);
    expect(predict).toBe('2026 major');
  });
  test('tennis grand slam: bare Predict form → "<year> grand slam"', () => {
    expect(normalizeEventNoun('Will Jannik Sinner win a Grand Slam in 2026?', 2026)).toBe('2026 grand slam');
  });
  test('tennis grand slam: qualified variants (Tennis / ATP / WTA) collapse to bare "grand slam"', () => {
    expect(normalizeEventNoun('Will Novak Djokovic win a Tennis Grand Slam in 2026?', 2026)).toBe('2026 grand slam');
    expect(normalizeEventNoun('Will X win an ATP Grand Slam in 2026?', 2026)).toBe('2026 grand slam');
    expect(normalizeEventNoun('Will X win a WTA Grand Slam in 2026?', 2026)).toBe('2026 grand slam');
  });
  test('tennis grand slam: Predict and Kalshi forms converge on the same key', () => {
    const predict = normalizeEventNoun('Will Jannik Sinner win a Grand Slam in 2026?', 2026);
    const kalshi = normalizeEventNoun('Will Novak Djokovic win a Tennis Grand Slam in 2026?', 2026);
    expect(predict).toBe(kalshi);
    expect(predict).toBe('2026 grand slam');
  });
  test('keep-bespoke: standalone "major league"/"grand prix" event nouns are UNCHANGED', () => {
    expect(normalizeEventNoun('Major League Soccer', 2026)).toBe('2026 major league soccer');
    expect(normalizeEventNoun('Will Marc Marquez win the Grand Prix de France?', 2026)).toBe('2026 grand prix de france');
  });
});

describe('normalizeEventNoun', () => {
  test('strips "Will <PERSON> win the " prefix + question mark', () => {
    expect(normalizeEventNoun('Will Daniel Quintero win the 2026 Colombian presidential election?'))
      .toBe('2026 colombia presidential election');
  });

  test('strips "Who will win the " prefix', () => {
    expect(normalizeEventNoun('Who will win the next French presidential election?', 2027))
      .toBe('2027 france presidential election');
  });

  test('Polymarket parent-event style (no prefix)', () => {
    expect(normalizeEventNoun('Colombia Presidential Election', 2026))
      .toBe('2026 colombia presidential election');
  });

  test('country adjective → noun: Colombian → colombia', () => {
    expect(normalizeEventNoun('2026 Colombian presidential election'))
      .toBe('2026 colombia presidential election');
  });

  test('country adjective → noun: French → france', () => {
    expect(normalizeEventNoun('2027 French presidential election'))
      .toBe('2027 france presidential election');
  });

  test('Kalshi "next X" with no year + yearHint', () => {
    expect(normalizeEventNoun('Will Rafael López Aliaga win the next Peruvian presidential election?', 2026))
      .toBe('2026 peru presidential election');
  });

  test('Polymarket + Kalshi converge on same canonical', () => {
    const pm = normalizeEventNoun('Colombia Presidential Election', 2026);
    const ks = normalizeEventNoun('Will Daniel Quintero win the next Colombian presidential election?', 2026);
    expect(pm).toBe(ks);
  });

  test('preserves explicit year over yearHint (no double year)', () => {
    expect(normalizeEventNoun('Will X win the 2026 Brazilian presidential election?', 2027))
      .toBe('2026 brazil presidential election');
  });

  test('handles "1st round" qualifier (preserves word order)', () => {
    // Imperfect: Polymarket "Colombia Presidential Election 1st round winner"
    // and Kalshi "Will X win the first round of 2026 Colombian presidential election?"
    // produce DIFFERENT normalized strings — acceptable, since 1st round vs
    // final are distinct events anyway.
    expect(normalizeEventNoun('Will Daniel Quintero win the first round of the 2026 Colombian presidential election?'))
      .toBe('first round of the 2026 colombia presidential election');
  });

  test('championship (Template C): "Will <TEAM> win the X" + year-inject', () => {
    expect(normalizeEventNoun('Will Manchester City win the UEFA Champions League?', 2026))
      .toBe('2026 uefa champions league');
  });

  test('championship: Polymarket parent (no Will prefix) converges with Kalshi form', () => {
    expect(normalizeEventNoun('UEFA Champions League', 2026))
      .toBe('2026 uefa champions league');
  });

  test('stage_advance (Template D): "advance to" verb stripped', () => {
    expect(normalizeEventNoun('Will Boston Celtics advance to the Conference Finals in the 2026 NBA Playoffs?'))
      .toBe('conference finals in the 2026 nba playoffs');
  });

  test('stage_advance: "reach the" variant', () => {
    expect(normalizeEventNoun('Will Lakers reach the Western Conference Finals?', 2026))
      .toBe('2026 western conference finals');
  });

  test('returns empty for null/empty input', () => {
    expect(normalizeEventNoun(null)).toBe('');
    expect(normalizeEventNoun('')).toBe('');
    expect(normalizeEventNoun('   ')).toBe('');
  });

  test('does not inject implausible year hints', () => {
    expect(normalizeEventNoun('Colombia Presidential Election', 1999)).toBe('colombia presidential election');
    expect(normalizeEventNoun('Colombia Presidential Election', 2200)).toBe('colombia presidential election');
  });

  test('strips "Final of the X" prefix so Kalshi WC final merges with Polymarket WC', () => {
    // Kalshi: "Will Curacao win the Final of the 2026 Men's FIFA World Cup?"
    // After championship stems: "final of the 2026 world cup"
    // After this stem:          "2026 world cup"
    expect(normalizeEventNoun("Will Curacao win the Final of the 2026 Men's FIFA World Cup?"))
      .toBe('2026 world cup');
  });

  test('Kalshi WC final and Polymarket WC titles converge', () => {
    const kalshi = normalizeEventNoun("Will Curacao win the Final of the 2026 Men's FIFA World Cup?");
    const polymarket = normalizeEventNoun('Will Cape Verde win the 2026 FIFA World Cup?');
    expect(kalshi).toBe(polymarket);
  });

  test('reorders trailing "in YYYY" to leading year (Ballon d\'Or)', () => {
    // Kalshi: "Who will win the Ballon d'Or in 2026?" → "ballon d or in 2026"
    // After reorder:                                    "2026 ballon d or"
    expect(normalizeEventNoun("Who will win the Ballon d'Or in 2026?"))
      .toBe('2026 ballon d or');
  });

  test('trailing-year reorder converges with Polymarket leading-year form', () => {
    const kalshi = normalizeEventNoun("Who will win the Ballon d'Or in 2026?");
    const polymarket = normalizeEventNoun("Will Kylian Mbappé win the 2026 Ballon d'Or?");
    expect(kalshi).toBe(polymarket);
  });

  test('diacritics fold to ASCII base, not stripped to a space (São Paulo)', () => {
    expect(normalizeEventNoun('São Paulo Mayoral Election', 2026))
      .toBe('2026 sao paulo mayoral election');
    expect(normalizeEventNoun('Grande Prêmio de São Paulo', 2026))
      .toBe('2026 grande premio de sao paulo');
  });

  test('trailing-year reorder does not double-tag when year already present', () => {
    // "2026 X in 2026" should not become "2026 2026 X" — the head already has a year.
    expect(normalizeEventNoun('Will X win the 2026 Eurovision in 2026?'))
      .toBe('2026 eurovision in 2026');
  });

  test('title-snapshot: "Will <PERSON> be the X Champion on <date>"', () => {
    // Polymarket UFC year-end title-holder market. The fighter prefix, the
    // "Champion" noun, and the trailing date should all be stripped so the
    // canonical_event merges across fighters in the same weight class.
    // yearHint in production is sourced from end_date via extractEventDate.
    expect(normalizeEventNoun('Will Tom Aspinall be the UFC Heavyweight Champion on December 31, 2026?', 2026))
      .toBe('2026 ufc heavyweight');
  });

  test('title-snapshot: all fighters in same race share canonical_event', () => {
    const a = normalizeEventNoun('Will Tom Aspinall be the UFC Heavyweight Champion on December 31, 2026?', 2026);
    const b = normalizeEventNoun('Will Sergei Pavlovich be the UFC Heavyweight Champion on December 31, 2026?', 2026);
    const c = normalizeEventNoun('Will Curtis Blaydes be the UFC Heavyweight Champion on December 31, 2026?', 2026);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('title-snapshot: Kalshi "Who will hold the X Title on <date>" form converges', () => {
    expect(normalizeEventNoun('Who will hold the WBC Featherweight Title on January 1, 2027?', 2027))
      .toBe('2027 wbc featherweight');
  });

  test('date-suffix strip: by / at-the-end-of connectors + trailing time (over-capture fix)', () => {
    // Trailing time-of-day must not leak into the entity (same as the `on <date>` case).
    expect(normalizeEventNoun('Will Tom Aspinall be the UFC Heavyweight Champion on December 31, 2026 at 11pm EST?', 2026))
      .toBe('2026 ufc heavyweight');
    expect(normalizeEventNoun('Who will hold the WBC Featherweight Title at the end of January 1, 2027?', 2027))
      .toBe('2027 wbc featherweight');
    // "by <date>" — assert the date tokens are gone (robust to other normalization steps).
    const byDate = normalizeEventNoun('Will the Lakers win the NBA Championship by June 30, 2026?', 2026);
    expect(byDate).not.toContain('june');
    expect(byDate).not.toContain('30');
    expect(byDate).toContain('championship');
  });

  test('title-snapshot: Kalshi "Who will be the X Title Holder on <date>" form converges', () => {
    expect(normalizeEventNoun('Who will be the Welterweight Title Holder on Dec 31, 2026?', 2026))
      .toBe('2026 welterweight');
  });

  test('title-snapshot: cross-platform Polymarket UFC ↔ Kalshi form merge', () => {
    const polymarket = normalizeEventNoun(
      'Will Israel Adesanya be the UFC Middleweight Champion on December 31, 2026?',
      2026,
    );
    const kalshi = normalizeEventNoun(
      'Who will hold the UFC Middleweight Title on December 31, 2026?',
      2026,
    );
    expect(polymarket).toBe(kalshi);
  });

  test('title-snapshot: "be the X Winner" (Kalshi MotoGP) form, no date suffix', () => {
    // Kalshi: "Will Marco Bezzecchi be the Grand Prix de France Winner?"
    // Fighter strip + trailing "winner" strip → "grand prix de france".
    expect(normalizeEventNoun('Will Marco Bezzecchi be the Grand Prix de France Winner?', 2026))
      .toBe('2026 grand prix de france');
  });

  test('"be the X Winner" merges with "win the X" form', () => {
    const beThe = normalizeEventNoun('Will Marco Bezzecchi be the Grand Prix de France Winner?', 2026);
    const winThe = normalizeEventNoun('Will Marc Marquez win the Grand Prix de France?', 2026);
    expect(beThe).toBe(winThe);
  });
});

describe('normalizeFixtureCanonicalEvent', () => {
  test('alphabetically sorts "A vs B" so platform team order does not matter', () => {
    expect(normalizeFixtureCanonicalEvent('Morocco vs Brazil')).toBe('Brazil vs Morocco');
    expect(normalizeFixtureCanonicalEvent('Brazil vs Morocco')).toBe('Brazil vs Morocco');
  });

  test('strips "Will" prefix and sorts (Predict per-fixture derived)', () => {
    expect(normalizeFixtureCanonicalEvent('Will Morocco vs Brazil end in a draw?'))
      .toBe('Brazil vs Morocco');
  });

  test('strips ": draw at halftime" sub-market suffix and alphabetizes', () => {
    // After stripping the qualifier the half-time draw market for
    // Brazil/Morocco collapses to the same canonical_event as the
    // same-fixture full-time markets.
    expect(normalizeFixtureCanonicalEvent('Morocco vs Brazil: draw at halftime'))
      .toBe('Brazil vs Morocco');
  });

  test('vs. → vs and sorts', () => {
    expect(normalizeFixtureCanonicalEvent('Morocco vs. Brazil')).toBe('Brazil vs Morocco');
  });

  test('strips trailing " winner?" suffix (Kalshi "X vs Y winner?" → "X vs Y")', () => {
    // FIXTURE_QUESTION_SUFFIX_RX matches " winner" + optional "?" so the
    // Kalshi match-winner format aligns with Polymarket's bare "X vs Y"
    // canonical_event.
    expect(normalizeFixtureCanonicalEvent('Doosan Bears vs Kia Tigers winner?'))
      .toBe('Doosan Bears vs Kia Tigers');
    expect(normalizeFixtureCanonicalEvent('Miami vs Minnesota Winner?'))
      .toBe('Miami vs Minnesota');
    // Sorted form after strip
    expect(normalizeFixtureCanonicalEvent('Lakers vs Celtics winner?'))
      .toBe('Celtics vs Lakers');
  });

  test('strips Limitless "<fixture>: N+ total <metric>?" suffix and alphabetizes', () => {
    expect(normalizeFixtureCanonicalEvent('1. FC Heidenheim vs FSV Mainz 05: 11+ total corners?'))
      .toBe('1. Heidenheim vs FSV Mainz 05');
    // "AC Milan" stays as-is — the club-code strip only handles mid-string FC/BC/AC/
    // CF/SC/CD/AFC followed by whitespace; leading "AC " isn't stripped (it would
    // ambiguously match real names that start with these letters, e.g. "AC/DC").
    // Alphabetize: "ac milan" < "atalanta" lex, so order is preserved.
    expect(normalizeFixtureCanonicalEvent('AC Milan vs Atalanta: 3+ total goals?'))
      .toBe('AC Milan vs Atalanta');
  });

  test('strips Template H ": O/U N" market-type suffix', () => {
    expect(normalizeFixtureCanonicalEvent('Arsenal FC vs. Chelsea FC: O/U 2.5'))
      .toBe('Arsenal vs Chelsea');
    expect(normalizeFixtureCanonicalEvent('Bulls vs. Thunder: 1H O/U 114.5'))
      .toBe('Bulls vs Thunder');
    expect(normalizeFixtureCanonicalEvent('Pavlovic vs. Walton: Total Sets O/U 2.5'))
      .toBe('Pavlovic vs Walton');
  });

  test('strips ": Both Teams to Score" / ": BTTS" market-type suffix', () => {
    expect(normalizeFixtureCanonicalEvent('Arsenal FC vs. Chelsea FC: Both Teams to Score'))
      .toBe('Arsenal vs Chelsea');
    expect(normalizeFixtureCanonicalEvent('Lorient vs Le Havre: BTTS'))
      .toBe('Le Havre vs Lorient');
  });

  test('strips Kalshi event_title ": Total Goals" / ": BTTS" suffix', () => {
    // Kalshi event_title is the upstream fixture name for KX*TOTAL / KX*BTTS
    // series — same convention as Limitless / Polymarket sub-market suffix.
    expect(normalizeFixtureCanonicalEvent('Remo vs Bahia: Total Goals'))
      .toBe('Bahia vs Remo');
    expect(normalizeFixtureCanonicalEvent('Bilbao vs Celta Vigo: BTTS'))
      .toBe('Bilbao vs Celta Vigo');
  });

  test('Heidenheim cross-shape alignment (regression case)', () => {
    // normalizeFixtureCanonicalEvent applies across shapes, so a
    // monotonic_threshold market and a binary_event market on the same
    // fixture collapse to the same string.
    expect(normalizeFixtureCanonicalEvent('1. FC Heidenheim 1846 vs. 1. FSV Mainz 05'))
      .toBe('1. FSV Mainz 05 vs 1. Heidenheim');
    expect(normalizeFixtureCanonicalEvent('1. FC Köln vs. 1. FC Heidenheim 1846'))
      .toBe('1. Heidenheim vs 1. Köln');
  });

  test('does NOT touch tournament prefixes like "Internazionali BNL d\'Italia:" (unknown prefix)', () => {
    // Conservative behavior — only known FIXTURE_PREFIX_RX entries (LoL, EPL,
    // BUNDL, Champions League, etc.) get stripped; arbitrary tournament names
    // pass through. The sort-step gate ("X vs Y" only) prevents reordering
    // when an unknown prefix remains.
    expect(normalizeFixtureCanonicalEvent("Internazionali BNL d'Italia: Lorenzo Musetti vs Francisco Cerundolo"))
      .toBe("Internazionali BNL d'Italia: Lorenzo Musetti vs Francisco Cerundolo");
  });
});

describe('yearFromIso', () => {
  test('extracts year from full ISO', () => {
    expect(yearFromIso('2026-05-10')).toBe(2026);
    expect(yearFromIso('2027-01-01')).toBe(2027);
    expect(yearFromIso('2026-05-13T19:10:00')).toBe(2026);
  });

  test('returns null for invalid input', () => {
    expect(yearFromIso(null)).toBe(null);
    expect(yearFromIso('')).toBe(null);
    expect(yearFromIso('not a date')).toBe(null);
  });

  test('rejects implausible years', () => {
    expect(yearFromIso('1999-01-01')).toBe(null);
    expect(yearFromIso('2200-01-01')).toBe(null);
  });
});
