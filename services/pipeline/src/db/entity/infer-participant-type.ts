/**
 * Subject-type inference at KB registration: a deterministic rule table that fires only on
 * low-confidence Stage-1 mints (template `'high'` always wins) and only when its scope
 * precondition is KB-confirmed. Bias is hard toward null since a wrong concrete type blocks
 * merges (the type gate treats 'unknown' as a wildcard but concrete types must match).
 * Pure and total: no DB, no throw, warm-inputs only.
 */
import { extractPartyToken } from '../../discriminators/specs/party.js';
import { ESPORTS_GAMES } from './sport-hierarchy.js';

export type InferredParticipantType = 'party' | 'person' | 'team';

export interface ParticipantTypeCtx {
  eventKind: string | null;
  domainCategory: string;
  sport: string | null;
  name: string;
  title: string | null;
  isSubject: boolean;
}

export interface InferredType {
  type: InferredParticipantType;
  basis: string;
}

const ELECTION_KINDS: ReadonlySet<string> = new Set([
  'election_outcome_winner',
  'election_margin',
  'election_turnout',
  'primary_winner',
]);

const ELECTION_CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  'election_outcome_winner',
  'primary_winner',
]);

const FIXTURE_MATCH_KINDS: ReadonlySet<string> = new Set([
  'match_winner',
  'halftime_leader',
  'exact_score',
  'both_teams_score',
  'match_spread',
]);

const INDIVIDUAL_AWARD_RX =
  /\b(?:mvp|most valuable player|(?:defender|defensive player|offensive player|player|goalkeeper|keeper|pitcher|hitter|reliever|rookie|coach|manager|sixth man|comeback player|freshman|newcomer|executive)\s+of\s+the\s+(?:year|month)|comeback player|golden\s+(?:boot|glove|ball|bat|stick)|platinum\s+glove|silver\s+slugger|hank\s+aaron|edgar\s+mart[ií]nez|outstanding\s+dh|cy young|ballon\s*d['’ ]?or|heisman|conn smythe|calder|norris|vezina|selke|hart(?:\s+trophy)?|jack adams|maurice richard|pichichi|player of the match)\b/i;

const STAT_LEADER_TITLE_RX =
  /\bmost\s+\w|\b(?:fewest|least)\s+\w|\b(?:top|leading)\s+(?:goal\s?)?scorer\b|\bscoring\s+(?:title|champion|lead)\b|\b(?:record|records|have|score|scores|lead|leads|make|makes|get|gets)\s+(?:the\s+)?most\b|\blead(?:s|ing)?\b[^.]*\bin\s+(?:goals?|points?|assists?|home\s?runs?|hrs?|rbis?|batting\s+average|(?:passing|rushing|receiving)\s+yards?|yards?|interceptions?|era|strikeouts?|wins?|hits?|saves?|rebounds?|steals?|blocks?|touchdowns?|tds?|sacks?|tackles?|shutouts?)\b|\blead(?:s|ing)?\b[^.]*\b(?:mlb|nba|nfl|nhl|wnba|mls|pro\s+\w+|major\s+league(?:\s+\w+)?)\b[^.]*\bin\b|\b(?:highest|lowest|best|leading)\s+(?:\w+[\s-]+){0,3}(?:average|era|ops|obp|whip|slugging|on[\s-]?base|percentage|rating|yards?|points?|goals?|runs?|home\s?runs?|rbis?|hits?|strikeouts?|wins?|saves?|assists?|rebounds?|tackles?|sacks?)\b|\b(?:highest|lowest|best|most|leading)\b[^.]*\bin\s+the\s+(?:\d{4}\s+)?(?:mlb|nba|nfl|nhl|wnba|mls|major\s+league(?:\s+\w+)?|american\s+league|national\s+league|premier\s+league)\b|\bgoal\s+contributions?\b|\bclean\s+sheets?\b|\b(?:yellow|red)\s+cards?\b/i;

// Award check runs first so "Most Valuable Player" reads as MVP, not a stat.
function championshipTitleClass(title: string | null): 'person' | 'ambiguous' | 'sport' {
  if (!title) return 'sport';
  if (INDIVIDUAL_AWARD_RX.test(title)) return 'person';
  if (STAT_LEADER_TITLE_RX.test(title)) return 'ambiguous';
  return 'sport';
}

// `labor` (not `labour`) lives here rather than in extractPartyToken's registry, since adding
// it there would mis-stamp economics "labor market" rows; here it's election-kind-gated.
const PARTY_ORG_RX =
  /\b(?:part(?:y|ies)|movement|alliance|coalition|rally|bloc|labor|national\s+congress)\b/i;

const PLURAL_PARTY_RX = /\b(?:democrats|republicans|tories|greens|liberals|conservatives|socialists|nationalists)\b/i;

export function looksLikeParty(name: string): boolean {
  if (PARTY_ORG_RX.test(name)) return true;
  if (extractPartyToken(name) == null) return false;
  // "John Tory" / "Jane Green": a two-word Titlecase personal name whose only party evidence
  // is a singular surname-risky token is a PERSON; plural/collective names are exempt.
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(name.trim()) && !PLURAL_PARTY_RX.test(name)) {
    return false;
  }
  return true;
}

const PERSONNEL_KINDS: ReadonlySet<string> = new Set([
  'personnel_move',
  'participation',
]);

const TEAM_SPORTS: ReadonlySet<string> = new Set([
  'soccer',
  'basketball',
  'american football',
  'baseball',
  'ice hockey',
  'field hockey',
  'hockey',
  'cricket',
  'rugby union',
  'rugby league',
  'lacrosse',
  'volleyball',
]);

const SOLO_SPORTS: ReadonlySet<string> = new Set([
  'tennis',
  'table tennis',
  'golf',
  'mma',
  'boxing',
  'squash',
  'darts',
  'snooker',
  'chess',
  'athletics',
]);

function baseSport(sport: string): string {
  return sport.toLowerCase().replace(/\s*\(ncaa\)\s*$/, '').trim();
}

// First match wins. Returns null when no rule applies (caller keeps the existing 'unknown' path).
export function inferParticipantType(ctx: ParticipantTypeCtx): InferredType | null {
  const kind = ctx.eventKind;
  if (!kind) return null;

  if (ELECTION_KINDS.has(kind)) {
    if (looksLikeParty(ctx.name)) return { type: 'party', basis: 'party' };
    if (ELECTION_CANDIDATE_KINDS.has(kind)) {
      // Eurovision/song-contest markets are mis-categorised as elections; the "candidate" is a
      // COUNTRY, not a person.
      if (/\beurovision\b|\bsong contest\b/i.test(ctx.title ?? '')) return null;
      if (/^[A-Z0-9]{2,6}$/.test(ctx.name.trim())) return null; // acronym → unknown, not a person
      return { type: 'person', basis: 'election_person' };
    }
    return null;
  }

  if (FIXTURE_MATCH_KINDS.has(kind)) return bySport(ctx.sport);

  if (kind === 'championship_winner') {
    const cls = championshipTitleClass(ctx.title);
    if (cls === 'person') return { type: 'person', basis: 'individual_award' };
    if (cls === 'ambiguous') return null;
    return bySport(ctx.sport);
  }

  if (PERSONNEL_KINDS.has(kind) && ctx.isSubject) {
    return { type: 'person', basis: 'personnel' };
  }

  return null;
}

function bySport(sport: string | null): InferredType | null {
  if (!sport) return null;
  const s = baseSport(sport);
  if (TEAM_SPORTS.has(s) || ESPORTS_GAMES.has(s)) return { type: 'team', basis: 'team_sport' };
  if (SOLO_SPORTS.has(s)) return { type: 'person', basis: 'solo_sport' };
  return null;
}
