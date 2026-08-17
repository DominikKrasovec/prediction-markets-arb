/**
 * Pure unit tests for the participant-type rule table.
 *
 * SOUNDNESS the tests guard (a WRONG concrete type BLOCKS merges, so the rule
 * is conservative — the whole file is "fires only on KB-confirmed scope, else
 * null"):
 *  - precedence order (party > election-person > sport > championship > personnel);
 *  - the sport rules fire ONLY on a recognized TEAM/SOLO sport (ambiguous
 *    motorsport / bare-esports-umbrella / NULL scope → null → unknown path);
 *  - championship_winner disambiguates award (person) / stat-leader (null) /
 *    team-title (sport rule) via the TITLE, so a team-sport MVP is a person and
 *    a nation stat-leader stays unknown;
 *  - personnel person-slot is SUBJECT-only (the club participant falls through);
 *  - a name is never typed for a kind outside the covered set (the "template
 *    'high' always wins" contract is enforced at the call site, which only calls
 *    this on the low-confidence mint).
 */
import { describe, test, expect } from 'bun:test';
import { inferParticipantType, looksLikeParty, type ParticipantTypeCtx } from './infer-participant-type.js';

/** Build a ctx with the fields a test cares about; sane defaults for the rest. */
function ctx(p: Partial<ParticipantTypeCtx>): ParticipantTypeCtx {
  return {
    eventKind: p.eventKind ?? null,
    domainCategory: p.domainCategory ?? 'sports',
    sport: p.sport ?? null,
    name: p.name ?? 'X',
    isSubject: p.isSubject ?? true,
    title: p.title ?? null,
  };
}

describe('inferParticipantType — election (rules 1 + 2)', () => {
  test('party subject in an election winner → party', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'Labour', title: 'Who will win the next Nigerian Senate election?' })))
      .toEqual({ type: 'party', basis: 'party' });
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'Sweden Democrats' }))?.type).toBe('party');
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'Australian Labor Party' }))?.type).toBe('party');
    expect(inferParticipantType(ctx({ eventKind: 'election_margin', domainCategory: 'politics', name: 'Republicans' }))?.type).toBe('party');
  });

  test('candidate person in an election winner → person', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'Randy Fine', title: 'Will Randy Fine be the Republican nominee for FL-06?' })))
      .toEqual({ type: 'person', basis: 'election_person' });
    expect(inferParticipantType(ctx({ eventKind: 'primary_winner', domainCategory: 'politics', name: 'Ruben Gallego' }))?.type).toBe('person');
  });

  test('"John Tory" is a PERSON, not the Tory party (surname false-positive suppressed)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'John Tory', title: 'Will John Tory win the 2026 Toronto mayoral election?' })))
      .toEqual({ type: 'person', basis: 'election_person' });
  });

  test('bare all-caps party acronym → null (not a person)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'politics', name: 'KOSP', title: 'Will KOSP win the most seats?' }))).toBeNull();
  });

  test('Eurovision "election" → null (the candidate is a country act, not a person)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_outcome_winner', domainCategory: 'election', name: 'United Kingdom', title: 'Who will win the Jury Vote in Eurovision 2026?' }))).toBeNull();
  });

  test('election_margin / turnout with NO party token → null (a margin band is not a candidate person)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'election_margin', domainCategory: 'politics', name: 'GA-09 house race' }))).toBeNull();
    expect(inferParticipantType(ctx({ eventKind: 'election_turnout', domainCategory: 'politics', name: 'Some Turnout Band' }))).toBeNull();
  });
});

describe('inferParticipantType — fixture MATCH (rule 3)', () => {
  test('TEAM sport competitor → team', () => {
    for (const sport of ['soccer', 'basketball', 'american football', 'baseball', 'ice hockey', 'cricket', 'rugby union', 'volleyball']) {
      expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport, name: 'Some Club' })))
        .toEqual({ type: 'team', basis: 'team_sport' });
    }
  });

  test('esports team titles → team (ESPORTS_GAMES reuse); bare "esports" umbrella → null', () => {
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'cs2', name: 'Team Heretics' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'league of legends', name: 'Top Esports' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'esports', name: 'Someone' }))).toBeNull();
  });

  test('SOLO sport competitor → person', () => {
    for (const sport of ['tennis', 'golf', 'mma', 'boxing', 'darts', 'snooker', 'table tennis']) {
      expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport, name: 'A Player' })))
        .toEqual({ type: 'person', basis: 'solo_sport' });
    }
  });

  test('other fixture MATCH kinds also route by sport', () => {
    expect(inferParticipantType(ctx({ eventKind: 'exact_score', sport: 'soccer', name: 'Spain' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'both_teams_score', sport: 'soccer', name: 'Peru' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'match_spread', sport: 'basketball', name: 'Lakers' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'halftime_leader', sport: 'american football', name: 'Chiefs' }))?.type).toBe('team');
  });

  test('ambiguous / unrecognized / NULL sport → null (fall through to unknown)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'formula 1', name: 'Verstappen' }))).toBeNull();
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'nascar', name: 'X' }))).toBeNull();
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'horse racing', name: 'X' }))).toBeNull();
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: null, name: 'X' }))).toBeNull();
  });

  test('(ncaa) league-scoped sport folds to the base sport', () => {
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'basketball (ncaa)', name: 'Duke' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'match_winner', sport: 'american football (ncaa)', name: 'LSU' }))?.type).toBe('team');
  });
});

describe('inferParticipantType — championship_winner (rule 4)', () => {
  test('team title → team (team sport) / person (solo sport)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'soccer', name: 'Basel', title: 'Will Basel win the 2025-26 UEFA Europa League?' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'basketball', name: 'OKC Thunder', title: '2026 NBA Champion: Oklahoma City Thunder' }))?.type).toBe('team');
    expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'tennis', name: 'Alcaraz', title: 'Will Alcaraz win Wimbledon 2026?' }))?.type).toBe('person');
    expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'golf', name: 'Ludvig Aberg', title: 'Will Ludvig Aberg win the 2026 PGA Championship?' }))?.type).toBe('person');
  });

  test('individual AWARD in a team sport → person (not team)', () => {
    for (const title of [
      '2026 NBA MVP: Nikola Jokic',
      'Will Tyler Marsh win the 2026 WNBA Coach of the Year award?',
      'Will Donovan Pines win 2026 MLS Defender of the Year?',
      'Who will win James Norris Memorial Trophy?',
      "Who will win the Ballon d'Or in 2026?",
      'Who will win Heisman Trophy?',
    ]) {
      expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'basketball', name: 'A Player', title })))
        .toEqual({ type: 'person', basis: 'individual_award' });
    }
  });

  test('stat-leader ("most goals" / "top goalscorer" / "clean sheets") → null (athlete-or-nation)', () => {
    for (const title of [
      'Will France score the most goals at the 2026 FIFA World Cup?',
      'Will Kylian Mbappe be the top goalscorer at the 2026 FIFA World Cup?',
      'Will Mory Diaw be the goalie with the most clean sheets during 2026?',
      'Will Giakoumakis record the most yellow cards in 2026?',
    ]) {
      expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'soccer', name: 'Subj', title }))).toBeNull();
    }
  });

  test('team-sport STAT-LEADER crown ("lead the MLB in home runs" etc.) → null (athlete-or-team), never team', () => {
    for (const title of [
      'Will Aaron Judge lead the MLB in home runs in 2026?',
      'Who will lead the American League in RBIs?',
      'Will Patrick Mahomes lead Pro Football in Passing Yards in 2026?',
      'Will Parker Messick lead Pro Baseball in ERA?',
      'Who will lead the NBA in rebounds this season?',
      'Will he lead the NFL in interceptions?',
    ]) {
      expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'baseball', name: 'Subj', title }))).toBeNull();
    }
  });

  test('team-sport INDIVIDUAL honors (Hank Aaron, Silver Slugger, Platinum Glove, Outstanding DH, Player of the Month) → person', () => {
    for (const title of [
      'Will Shohei Ohtani win the 2026 Hank Aaron Award?',
      'Who will win the 2026 AL Silver Slugger at shortstop?',
      'Will Bobby Witt Jr. win a Platinum Glove in 2026?',
      'Will David Ortiz win the Edgar Martinez Outstanding DH Award?',
      'Who will win NL Player of the Month for May 2026?',
      'Will Caleb Williams win NFL Comeback Player of the Year?',
    ]) {
      expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: 'baseball', name: 'A Player', title })))
        .toEqual({ type: 'person', basis: 'individual_award' });
    }
  });

  test('championship with no sport scope → null even with a team-title cue', () => {
    expect(inferParticipantType(ctx({ eventKind: 'championship_winner', sport: null, name: 'X', title: 'Will X win the Cup?' }))).toBeNull();
  });
});

describe('inferParticipantType — personnel/participation (rule 5)', () => {
  test('SUBJECT slot (the person) → person', () => {
    expect(inferParticipantType(ctx({ eventKind: 'personnel_move', sport: 'soccer', name: 'Xavi', isSubject: true, title: 'Xavi to leave Barcelona by Sept 1, 2026?' })))
      .toEqual({ type: 'person', basis: 'personnel' });
    expect(inferParticipantType(ctx({ eventKind: 'participation', sport: 'soccer', name: 'Mbappe', isSubject: true }))?.type).toBe('person');
  });

  test('non-subject slot (the CLUB) → null (not mis-typed a person)', () => {
    expect(inferParticipantType(ctx({ eventKind: 'personnel_move', sport: 'soccer', name: 'Chicago', isSubject: false, title: 'Who will be the next Head Coach of the Chicago?' }))).toBeNull();
  });
});

describe('inferParticipantType — out-of-scope kinds → null', () => {
  test('kinds handled by high-confidence templates are never typed here', () => {
    for (const eventKind of ['player_prop_threshold', 'match_total_metric', 'stage_advance', 'weather_extreme', 'price_threshold', 'other', null]) {
      expect(inferParticipantType(ctx({ eventKind, sport: 'soccer', name: 'X' }))).toBeNull();
    }
  });
});

describe('looksLikeParty', () => {
  test('true for party names + org designators', () => {
    for (const n of ['Labour', 'Likud', 'SNP', 'Green Party', 'National Rally', 'Free Patriotic Movement', 'Watani Alliance', 'Australian Labor Party', 'Sweden Democrats']) {
      expect(looksLikeParty(n)).toBe(true);
    }
  });
  test('false for candidate persons (incl. the "John Tory" surname trap)', () => {
    for (const n of ['John Tory', 'Randy Fine', 'Ruben Gallego', 'Nikema Williams', 'Delyan Peevski']) {
      expect(looksLikeParty(n)).toBe(false);
    }
  });
});
