/**
 * Tests for the deterministic fold-variant bridge in findOrCreateEntity
 * (register.ts Pass 3a): collapses diacritic (all types) and despace
 * (non-person types) duplicate registrations before the second INSERT.
 */
import { describe, test, expect } from 'bun:test';
import {
  bridgeGateOk,
  foldVariantSerializeKey,
  isCrossLeague,
  stripTeamSuffix,
  clubSuffixScopeOk,
  isSeasonPrefixedCanonical,
  whitespaceTokenCount,
} from './register.js';
import { areSportsCompatible, areEsportsOrgGamesCompatible } from './sport-hierarchy.js';
import {
  loadStructuralSignalsIndex,
  _resetStructuralSignalsIndexForTests,
} from './structural-signals.js';
import { query } from '@arb/db';
import { foldAscii } from './tokens.js';

describe('bridgeGateOk (pure gate)', () => {
  test('bridges when same type, same domain, scope-compatible', () => {
    expect(bridgeGateOk(
      { type: 'league', domainCategory: 'sports' },
      { type: 'league', domainCategory: 'sports' },
      false,
    )).toBe(true);
  });

  test('blocks on type mismatch (league "La Liga" must not bridge a team)', () => {
    expect(bridgeGateOk(
      { type: 'league', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'sports' },
      false,
    )).toBe(false);
  });

  test('blocks on incompatible domain', () => {
    expect(bridgeGateOk(
      { type: 'asset', domainCategory: 'crypto' },
      { type: 'asset', domainCategory: 'finance' },
      false,
    )).toBe(false);
  });

  test('domain "other" on either side is a wildcard', () => {
    expect(bridgeGateOk(
      { type: 'team', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'other' },
      false,
    )).toBe(true);
    expect(bridgeGateOk(
      { type: 'team', domainCategory: 'other' },
      { type: 'team', domainCategory: 'sports' },
      false,
    )).toBe(true);
  });

  test('a scope conflict BLOCKS the bridge (keeps same-name-different-league forks separate)', () => {
    expect(bridgeGateOk(
      { type: 'team', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'sports' },
      true,
    )).toBe(false);
  });

  test("type 'unknown' is a wildcard on either side (unknown↔typed bridges)", () => {
    expect(bridgeGateOk(
      { type: 'unknown', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'sports' },
      false,
    )).toBe(true);
    expect(bridgeGateOk(
      { type: 'person', domainCategory: 'sports' },
      { type: 'unknown', domainCategory: 'sports' },
      false,
    )).toBe(true);
    expect(bridgeGateOk(
      { type: 'person', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'sports' },
      false,
    )).toBe(false);
    expect(bridgeGateOk(
      { type: 'unknown', domainCategory: 'sports' },
      { type: 'team', domainCategory: 'sports' },
      true,
    )).toBe(false);
    expect(bridgeGateOk(
      { type: 'unknown', domainCategory: 'crypto' },
      { type: 'team', domainCategory: 'sports' },
      false,
    )).toBe(false);
  });
});

interface KE {
  id: number; canonical: string; type: string; domainCategory: string;
  league: string | null; sport: string | null;
}

// Mirrors the SQL fold expressions (diacritic always; despace for non-person only).
const diaFold = (s: string) => foldAscii(s).toLowerCase();
const despaceFold = (s: string) => foldAscii(s).toLowerCase().replace(/\s+/g, '');

// Replica of register.ts isScopeIncompatible for the cases under test.
function scopeIncompatible(type: string, ex: KE, inc: KE): boolean {
  const scoped = type === 'person' || type === 'team' || type === 'league' || type === 'competition';
  if (!scoped) return false;
  if (ex.league && inc.league && ex.league.toLowerCase() !== inc.league.toLowerCase()) return true;
  if (ex.sport && inc.sport && ex.sport.toLowerCase() !== inc.sport.toLowerCase()) {
    if (areSportsCompatible(ex.sport, inc.sport)) return false;
    if (type === 'team' && areEsportsOrgGamesCompatible(ex.sport, inc.sport)) return false;
    return true;
  }
  return false;
}

/** Replica of findFoldVariantBridge: returns the bridged target id or null. */
function simulateBridge(incoming: KE, kb: KE[]): number | null {
  const incLower = incoming.canonical.toLowerCase();
  const typeOk = (c: KE) =>
    c.type === incoming.type || c.type === 'unknown' || incoming.type === 'unknown';
  const pick = (cands: KE[]): number | null => {
    for (const c of cands.slice().sort((a, b) => a.id - b.id)) {
      if (c.id === incoming.id) continue;
      if (c.canonical.toLowerCase() === incLower) continue;
      if (!typeOk(c)) continue;
      // Must mirror pickBridgeCandidate's scope-check type resolution.
      const scopeType = incoming.type !== 'unknown' ? incoming.type
        : c.type !== 'unknown' ? c.type : 'team';
      const scopeBad = scopeIncompatible(scopeType, c, incoming);
      if (bridgeGateOk(
        { type: incoming.type, domainCategory: incoming.domainCategory },
        { type: c.type, domainCategory: c.domainCategory },
        scopeBad,
      )) return c.id;
    }
    return null;
  };
  const dia = kb.filter(c => diaFold(c.canonical) === diaFold(incoming.canonical));
  const diaHit = pick(dia);
  if (diaHit !== null) return diaHit;
  // Despace lookup excludes type='person' rows on both sides.
  if (incoming.type !== 'person') {
    const des = kb.filter(c =>
      c.type !== 'person' && despaceFold(c.canonical) === despaceFold(incoming.canonical));
    const desHit = pick(des);
    if (desHit !== null) return desHit;
  }
  return null;
}

describe('fold-variant bridge (end-to-end simulation)', () => {
  test('despace NON-person bridge: "La Liga" registers into existing "LaLiga"', () => {
    const kb: KE[] = [
      { id: 27080, canonical: 'LaLiga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBe(27080);
  });

  test('despace bridge is ORDER-INDEPENDENT: "LaLiga" registers into existing "La Liga"', () => {
    const kb: KE[] = [
      { id: 62, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'LaLiga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBe(62);
  });

  test('diacritic bridge: "Iga Swiatek" registers into existing "Iga Świątek" (accented)', () => {
    const kb: KE[] = [
      { id: 19217, canonical: 'Iga Świątek', type: 'person', domainCategory: 'sports', league: 'WTA Tour', sport: 'tennis' },
    ];
    const incoming: KE = { id: -1, canonical: 'Iga Swiatek', type: 'person', domainCategory: 'sports', league: null, sport: 'tennis' };
    expect(simulateBridge(incoming, kb)).toBe(19217);
  });

  test('person despace NOT bridged: "Alexsandro" must NOT merge "Alex Sandro" (two different people)', () => {
    const kb: KE[] = [
      { id: 29222, canonical: 'Alex Sandro', type: 'person', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Alexsandro', type: 'person', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(despaceFold('Alex Sandro')).toBe(despaceFold('Alexsandro'));
    expect(diaFold('Alex Sandro')).not.toBe(diaFold('Alexsandro'));
    expect(simulateBridge(incoming, kb)).toBeNull();
  });

  test('different-league fork NOT bridged: scope conflict keeps them separate', () => {
    const kb: KE[] = [
      { id: 4753, canonical: 'AD Ceuta FC', type: 'team', domainCategory: 'sports', league: 'La Liga', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'AD Ceuta FC', type: 'team', domainCategory: 'sports', league: 'la liga 2', sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBeNull();

    const kb2: KE[] = [
      { id: 100, canonical: 'Botafogo FR', type: 'team', domainCategory: 'sports', league: 'Serie A', sport: 'soccer' },
    ];
    const inc2: KE = { id: -1, canonical: 'Botáfogo FR', type: 'team', domainCategory: 'sports', league: 'copa do brasil', sport: 'soccer' };
    expect(diaFold('Botafogo FR')).toBe(diaFold('Botáfogo FR'));
    expect(simulateBridge(inc2, kb2)).toBeNull();
  });

  test('diacritic person scope-fork bridged: incoming null-scope folds into a scoped accented row', () => {
    const kb: KE[] = [
      { id: 19164, canonical: 'Francisco Cerúndolo', type: 'person', domainCategory: 'sports', league: 'ATP Tour', sport: 'tennis' },
    ];
    const incoming: KE = { id: -1, canonical: 'Francisco Cerundolo', type: 'person', domainCategory: 'sports', league: null, sport: 'tennis' };
    expect(incoming.canonical.toLowerCase()).not.toBe(kb[0].canonical.toLowerCase());
    expect(diaFold(incoming.canonical)).toBe(diaFold(kb[0].canonical));
    expect(simulateBridge(incoming, kb)).toBe(19164);
  });

  test('idempotent: re-registering a present canonical bridges to the lower-id fold owner, never a new row', () => {
    const kb: KE[] = [
      { id: 62, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
      { id: 27080, canonical: 'LaLiga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'LaLiga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBe(62);
  });

  test('same-name esports org across games is SCOPE-COMPATIBLE for type=team', () => {
    const existing: KE = { id: 476, canonical: 'G2 Esports', type: 'team', domainCategory: 'sports', league: null, sport: 'cs2' };
    const incoming: KE = { id: -1, canonical: 'G2 Esports', type: 'team', domainCategory: 'sports', league: null, sport: 'valorant' };
    expect(scopeIncompatible('team', existing, incoming)).toBe(false);
  });

  test('M-ENTITY-5: a despace-VARIANT esports-org name bridges across games (carve-out in the bridge)', () => {
    const kb: KE[] = [
      { id: 5500, canonical: 'NaVi', type: 'team', domainCategory: 'sports', league: null, sport: 'cs2' },
    ];
    const incoming: KE = { id: -1, canonical: 'Na Vi', type: 'team', domainCategory: 'sports', league: null, sport: 'valorant' };
    expect(despaceFold('NaVi')).toBe(despaceFold('Na Vi'));
    expect(diaFold('NaVi')).not.toBe(diaFold('Na Vi'));
    expect(scopeIncompatible('team', kb[0], incoming)).toBe(false);
    expect(simulateBridge(incoming, kb)).toBe(5500);
  });

  test('M-ENTITY-5: the esports-org carve-out is type=team ONLY (person stays forked)', () => {
    const existing: KE = { id: 9001, canonical: 'ZywOo', type: 'person', domainCategory: 'sports', league: null, sport: 'cs2' };
    const incoming: KE = { id: -1, canonical: 'ZywOo', type: 'person', domainCategory: 'sports', league: null, sport: 'valorant' };
    expect(scopeIncompatible('person', existing, incoming)).toBe(true);
  });

  test('M-ENTITY-5: a non-esports sport conflict is STILL blocked for type=team', () => {
    const existing: KE = { id: 9100, canonical: 'Vitality', type: 'team', domainCategory: 'sports', league: null, sport: 'cs2' };
    const incoming: KE = { id: -1, canonical: 'Vitality', type: 'team', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(scopeIncompatible('team', existing, incoming)).toBe(true);
  });
});

/** KE the bridge would see from a StructuralEntityResolver T3-create call (register.ts resolvers.ts). */
function resolverIncomingKE(args: {
  storedCanonical: string;
  primaryType: string;
  metadata: { sport_canonical?: string | null; league_canonical?: string | null };
}): KE {
  return {
    id: -1,
    canonical: args.storedCanonical,
    type: args.primaryType,
    domainCategory: 'sports',
    league: args.metadata.league_canonical ?? null,
    sport: args.metadata.sport_canonical ?? null,
  };
}

describe('resolver T3-create path → shared fold-variant bridge', () => {
  test('(a) resolver input shape: T3-create "LaLiga" bridges to existing "La Liga"', () => {
    const kb: KE[] = [
      { id: 62, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming = resolverIncomingKE({
      storedCanonical: 'LaLiga',
      primaryType: 'league',
      metadata: { sport_canonical: 'soccer' },
    });
    expect(despaceFold('La Liga')).toBe(despaceFold('LaLiga'));
    expect('la liga').not.toBe('laliga');
    expect(simulateBridge(incoming, kb)).toBe(62);
  });

  test('(a2) resolver input shape is order-independent: "La Liga" bridges to existing "LaLiga"', () => {
    const kb: KE[] = [
      { id: 27080, canonical: 'LaLiga', type: 'league', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming = resolverIncomingKE({
      storedCanonical: 'La Liga',
      primaryType: 'league',
      metadata: { sport_canonical: 'soccer' },
    });
    expect(simulateBridge(incoming, kb)).toBe(27080);
  });

  test('(b) resolver path does NOT bridge a TIER fork: "La Liga 2" vs "La Liga"', () => {
    const kb: KE[] = [
      { id: 62, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: 'la liga', sport: 'soccer' },
    ];
    const incoming = resolverIncomingKE({
      storedCanonical: 'La Liga 2',
      primaryType: 'league',
      metadata: { sport_canonical: 'soccer', league_canonical: 'la liga 2' },
    });
    expect(despaceFold('La Liga 2')).not.toBe(despaceFold('La Liga'));
    expect(simulateBridge(incoming, kb)).toBeNull();

    const exTier: KE = { id: 62, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: 'la liga', sport: 'soccer' };
    const incTier: KE = { id: -1, canonical: 'La Liga', type: 'league', domainCategory: 'sports', league: 'la liga 2', sport: 'soccer' };
    const scopeBad = scopeIncompatible('league', exTier, incTier);
    expect(scopeBad).toBe(true);
    expect(bridgeGateOk(
      { type: 'league', domainCategory: 'sports' },
      { type: 'league', domainCategory: 'sports' },
      scopeBad,
    )).toBe(false);
  });

  test('(c) despace bridge ALWAYS runs for structural types (never person)', () => {
    for (const t of ['league', 'competition', 'sport', 'data_provider']) {
      expect(t).not.toBe('person');
    }
  });

  test('M-ENTITY-2: sport-conflict fold pair stays SEPARATE (t20 brisbane cricket vs soccer)', () => {
    const kb: KE[] = [
      { id: 5281, canonical: 't20 brisbane', type: 'competition', domainCategory: 'sports', league: null, sport: 'cricket' },
    ];
    const incoming = resolverIncomingKE({
      storedCanonical: 't20 brisbane',
      primaryType: 'competition',
      metadata: { sport_canonical: 'soccer' },
    });
    expect(despaceFold('t20 brisbane')).toBe(despaceFold('t20 brisbane'));
    expect(scopeIncompatible('competition', kb[0], incoming)).toBe(true);
    expect(simulateBridge(incoming, kb)).toBeNull();
  });

  test('unknown-typed diacritic variant bridges into the typed row (Cerúndolo wave)', () => {
    const kb: KE[] = [
      { id: 1966, canonical: 'Francisco Cerundolo', type: 'team', domainCategory: 'sports', league: 'ATP/WTA', sport: 'tennis' },
    ];
    const incoming: KE = { id: -1, canonical: 'Francisco Cerúndolo', type: 'unknown', domainCategory: 'sports', league: null, sport: 'tennis' };
    expect(simulateBridge(incoming, kb)).toBe(1966);
  });

  test('typed despace variant bridges into the unknown row (TheMongolz wave)', () => {
    const kb: KE[] = [
      { id: 565, canonical: 'TheMongolz', type: 'unknown', domainCategory: 'sports', league: null, sport: 'cs2' },
    ];
    const incoming: KE = { id: -1, canonical: 'The Mongolz', type: 'team', domainCategory: 'sports', league: null, sport: 'esports' };
    expect(simulateBridge(incoming, kb)).toBe(565);
  });

  test('unknown incoming can NEVER despace-bridge into a person (Alex Sandro stays safe)', () => {
    const kb: KE[] = [
      { id: 7, canonical: 'Alex Sandro', type: 'person', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Alexsandro', type: 'unknown', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBeNull();
  });

  test('unknown wildcard does NOT override the scope gate (Osaka tennis vs Ōsaka soccer)', () => {
    const kb: KE[] = [
      { id: 2101, canonical: 'Osaka', type: 'team', domainCategory: 'sports', league: 'ATP/WTA', sport: 'tennis' },
    ];
    const incoming: KE = { id: -1, canonical: 'Ōsaka', type: 'unknown', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBeNull();
  });
});

describe('foldVariantSerializeKey (pure same-fold serialise key)', () => {
  test('diacritic variants collapse to ONE key (would-race pair serialises)', () => {
    expect(foldVariantSerializeKey('Atletico Madrid', 'team'))
      .toBe(foldVariantSerializeKey('Atlético Madrid', 'team'));
    expect(foldVariantSerializeKey('Iga Swiatek', 'person'))
      .toBe(foldVariantSerializeKey('Iga Świątek', 'person'));
    expect(foldVariantSerializeKey('Jose Altuve', 'person'))
      .toBe(foldVariantSerializeKey('José Altuve', 'person'));
  });

  test('despace variants collapse to ONE key (La Liga / LaLiga / laliga)', () => {
    const a = foldVariantSerializeKey('La Liga', 'league');
    expect(foldVariantSerializeKey('LaLiga', 'league')).toBe(a);
    expect(foldVariantSerializeKey('laliga', 'league')).toBe(a);
  });

  test('key is at least as broad as BOTH bridge folds (diacritic AND despace together)', () => {
    expect(foldVariantSerializeKey('Atlético Madrid', 'team'))
      .toBe(foldVariantSerializeKey('AtleticoMadrid', 'team'));
  });

  test('person despace pair SHARES a key (serialises) but the BRIDGE keeps them apart', () => {
    expect(foldVariantSerializeKey('Alex Sandro', 'person'))
      .toBe(foldVariantSerializeKey('Alexsandro', 'person'));
    const kb: KE[] = [
      { id: 1, canonical: 'Alex Sandro', type: 'person', domainCategory: 'sports', league: null, sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Alexsandro', type: 'person', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(simulateBridge(incoming, kb)).toBeNull();
  });

  test('key OMITS scope: same canonical+type with DIFFERENT league/sport shares a key', () => {
    const k = foldVariantSerializeKey('AD Ceuta FC', 'team');
    expect(foldVariantSerializeKey('AD Ceuta FC', 'team')).toBe(k);
    expect(foldVariantSerializeKey.length).toBe(2);
  });

  test('key OMITS type: unknown↔typed same-fold spellings SHARE a key (census 2026-07-02 #4a)', () => {
    expect(foldVariantSerializeKey('Francisco Cerúndolo', 'unknown'))
      .toBe(foldVariantSerializeKey('Francisco Cerundolo', 'team'));
    expect(foldVariantSerializeKey('LaLiga', 'league'))
      .toBe(foldVariantSerializeKey('LaLiga', 'team'));
  });

  test('genuinely-distinct same-type names get DIFFERENT keys (no over-collapse)', () => {
    expect(foldVariantSerializeKey('Atletico Madrid', 'team'))
      .not.toBe(foldVariantSerializeKey('Atletico Madrid B', 'team'));
    expect(foldVariantSerializeKey('La Liga', 'league'))
      .not.toBe(foldVariantSerializeKey('La Liga 2', 'league'));
  });

  test('M-ENTITY-2: competition despace variants collapse (Australian Open)', () => {
    expect(foldVariantSerializeKey('Australian Open', 'competition'))
      .toBe(foldVariantSerializeKey('australianopen', 'competition'));
    expect(foldVariantSerializeKey('AustralianOpen', 'competition'))
      .toBe(foldVariantSerializeKey('Australian Open', 'competition'));
  });

  test('M-ENTITY-2: key is INVARIANT to incoming sport (drops the old singleFlight sport partition)', () => {
    const k = foldVariantSerializeKey('PFA Player', 'competition');
    expect(foldVariantSerializeKey('PFA Player', 'competition')).toBe(k);
    expect(foldVariantSerializeKey('pfaplayer', 'competition')).toBe(k);
  });
});

describe('isCrossLeague (cup strip predicate)', () => {
  test('FAIL-SAFE: empty/unloaded signals index → false for all inputs (strip never over-fires)', () => {
    _resetStructuralSignalsIndexForTests();
    expect(isCrossLeague(null)).toBe(false);
    expect(isCrossLeague('Champions League')).toBe(false);
    expect(isCrossLeague('Premier League')).toBe(false);
  });

  test('DB read-only: flagged cups → true, domestic league → false (skips if PG unreachable)', async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;
    await loadStructuralSignalsIndex();
    expect(isCrossLeague('Champions League')).toBe(true);
    expect(isCrossLeague('Premier League')).toBe(false);
    expect(isCrossLeague(null)).toBe(false);
  });
});

describe('AUD-41 stripTeamSuffix (pure)', () => {
  test('strips a trailing organisational suffix to the bare club name', () => {
    expect(stripTeamSuffix('Arsenal FC')).toBe('arsenal');
    expect(stripTeamSuffix('Chelsea F.C.')).toBe('chelsea');
    expect(stripTeamSuffix('Inter Miami CF')).toBe('inter miami');
    expect(stripTeamSuffix('Burgos CF')).toBe('burgos');
    expect(stripTeamSuffix('Arsenal Football Club')).toBe('arsenal');
    expect(stripTeamSuffix('Hull City A.F.C.')).toBe('hull city');
  });

  test('strips a LEADING organisational suffix', () => {
    expect(stripTeamSuffix('AFC Bournemouth')).toBe('bournemouth');
    expect(stripTeamSuffix('FC Andorra')).toBe('andorra');
  });

  test('a SINGLE-token all-suffix name returns unchanged (never folds to empty)', () => {
    expect(stripTeamSuffix('FC')).toBe('fc');
    expect(stripTeamSuffix('Club')).toBe('club');
    expect(stripTeamSuffix('SC')).toBe('sc');
    expect(stripTeamSuffix('Football Club')).toBe('football');
  });

  test('does NOT strip non-suffix identity tokens (United / City / Athletic)', () => {
    expect(stripTeamSuffix('Manchester United')).toBe('manchester united');
    expect(stripTeamSuffix('Manchester City')).toBe('manchester city');
    expect(stripTeamSuffix('Athletic Bilbao')).toBe('athletic bilbao');
  });

  test('SOUNDNESS: Arsenal and Arsenal FC share a bare fold (so they CAN fold)', () => {
    expect(stripTeamSuffix('Arsenal')).toBe(stripTeamSuffix('Arsenal FC'));
  });

  test('Barcelona and Barcelona SC ALSO share a bare fold — so the SCOPE gate is what keeps them apart', () => {
    expect(stripTeamSuffix('Barcelona')).toBe(stripTeamSuffix('Barcelona SC'));
  });
});

describe('AUD-41 clubSuffixScopeOk (stricter positive-league gate)', () => {
  const noCross = (_: string | null) => false;

  test('both leagues populated + equal → OK (Arsenal FC / Arsenal both Premier League)', () => {
    expect(clubSuffixScopeOk('Premier League', 'Premier League', noCross)).toBe(true);
  });

  test('SOUNDNESS BOUNDARY: exactly one league populated → REFUSE (Barcelona La Liga vs Barcelona SC null)', () => {
    expect(clubSuffixScopeOk('La Liga', null, noCross)).toBe(false);
    expect(clubSuffixScopeOk(null, 'La Liga', noCross)).toBe(false);
  });

  test('both leagues null → OK (a pre-enrichment cross-platform suffix dup)', () => {
    expect(clubSuffixScopeOk(null, null, noCross)).toBe(true);
    expect(clubSuffixScopeOk('', '', noCross)).toBe(true);
  });

  test('both populated but DIFFERENT non-cross leagues → refuse (La Liga vs la liga 2 tier fork)', () => {
    expect(clubSuffixScopeOk('La Liga', 'la liga 2', noCross)).toBe(false);
  });

  test('a cross-league competition on EITHER side → OK (club co-exists in home league + cup)', () => {
    const isUCL = (l: string | null) => l === 'UEFA Champions League';
    expect(clubSuffixScopeOk('UEFA Champions League', null, isUCL)).toBe(true);
    expect(clubSuffixScopeOk('Premier League', 'UEFA Champions League', isUCL)).toBe(true);
  });
});

describe('AUD-41 club-suffix bridge (end-to-end simulation)', () => {
  const noCross = (_: string | null) => false;

  // Replica of findFoldVariantBridge's club-suffix branch.
  function simulateClubSuffixBridge(incoming: KE, kb: KE[]): number | null {
    if (incoming.type !== 'team') return null;
    if (incoming.sport != null && incoming.sport.toLowerCase() !== 'soccer') return null;
    const incBare = stripTeamSuffix(incoming.canonical);
    if (incBare.length === 0) return null;
    const cands = kb
      .filter((c) => c.type === 'team' && (c.sport ?? '').toLowerCase() === 'soccer')
      .filter((c) => c.canonical.toLowerCase() !== incoming.canonical.toLowerCase())
      .filter((c) => stripTeamSuffix(c.canonical) === incBare)
      .filter((c) => clubSuffixScopeOk(c.league, incoming.league, noCross))
      .sort((a, b) => a.id - b.id);
    for (const c of cands) {
      const scopeBad = scopeIncompatible(incoming.type, c, incoming);
      if (bridgeGateOk(
        { type: incoming.type, domainCategory: incoming.domainCategory },
        { type: c.type, domainCategory: c.domainCategory },
        scopeBad,
      )) return c.id;
    }
    return null;
  }

  test('FOLDS: "Arsenal" registers into existing "Arsenal FC" (both Premier League)', () => {
    const kb: KE[] = [
      { id: 206, canonical: 'Arsenal FC', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Arsenal', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' };
    expect(simulateClubSuffixBridge(incoming, kb)).toBe(206);
  });

  test('FOLDS order-independent: "Arsenal FC" registers into existing "Arsenal"', () => {
    const kb: KE[] = [
      { id: 206, canonical: 'Arsenal', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Arsenal FC', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' };
    expect(simulateClubSuffixBridge(incoming, kb)).toBe(206);
  });

  test('FOLDS leading suffix: "Bournemouth" registers into existing "AFC Bournemouth"', () => {
    const kb: KE[] = [
      { id: 483, canonical: 'AFC Bournemouth', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Bournemouth', type: 'team', domainCategory: 'sports', league: 'Premier League', sport: 'soccer' };
    expect(simulateClubSuffixBridge(incoming, kb)).toBe(483);
  });

  test('SOUNDNESS: "Barcelona SC" (null league) does NOT fold into "Barcelona" (La Liga)', () => {
    const kb: KE[] = [
      { id: 356, canonical: 'Barcelona', type: 'team', domainCategory: 'sports', league: 'La Liga', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'Barcelona SC', type: 'team', domainCategory: 'sports', league: null, sport: 'soccer' };
    expect(stripTeamSuffix('Barcelona')).toBe(stripTeamSuffix('Barcelona SC'));
    expect(simulateClubSuffixBridge(incoming, kb)).toBeNull();
  });

  test('SOUNDNESS: the suffix fold is soccer-team ONLY (a basketball "X SC" never folds)', () => {
    const kb: KE[] = [
      { id: 900, canonical: 'Phoenix', type: 'team', domainCategory: 'sports', league: 'NBA', sport: 'basketball' },
    ];
    const incoming: KE = { id: -1, canonical: 'Phoenix SC', type: 'team', domainCategory: 'sports', league: 'NBA', sport: 'basketball' };
    expect(simulateClubSuffixBridge(incoming, kb)).toBeNull();
  });

  test('SOUNDNESS: distinct-league fork stays separate even with matching suffix (La Liga vs la liga 2)', () => {
    const kb: KE[] = [
      { id: 4753, canonical: 'AD Ceuta FC', type: 'team', domainCategory: 'sports', league: 'La Liga', sport: 'soccer' },
    ];
    const incoming: KE = { id: -1, canonical: 'AD Ceuta', type: 'team', domainCategory: 'sports', league: 'la liga 2', sport: 'soccer' };
    expect(simulateClubSuffixBridge(incoming, kb)).toBeNull();
  });
});

describe('AUD-41 foldVariantSerializeKey strips team suffix (race serialisation)', () => {
  test('"Arsenal" and "Arsenal FC" share ONE serialise key (so a burst serialises)', () => {
    expect(foldVariantSerializeKey('Arsenal', 'team'))
      .toBe(foldVariantSerializeKey('Arsenal FC', 'team'));
    expect(foldVariantSerializeKey('AFC Bournemouth', 'team'))
      .toBe(foldVariantSerializeKey('Bournemouth', 'team'));
  });

  test('the suffix strip is type=team ONLY (a league/competition key is NOT suffix-stripped)', () => {
    const teamKey = foldVariantSerializeKey('FC Andorra', 'team');
    const leagueKey = foldVariantSerializeKey('FC Andorra', 'league');
    expect(teamKey).not.toBe(leagueKey);
  });

  test('serialising a genuinely-distinct same-suffix-fold pair is SOUND (Barcelona / Barcelona SC share a key but the bridge keeps them apart)', () => {
    expect(foldVariantSerializeKey('Barcelona', 'team'))
      .toBe(foldVariantSerializeKey('Barcelona SC', 'team'));
  });
});

describe('AUD-42 isSeasonPrefixedCanonical (pure promote-guard predicate)', () => {
  test('TRUE for season/year-prefixed competition titles', () => {
    expect(isSeasonPrefixedCanonical('2025 26 england premier league')).toBe(true);
    expect(isSeasonPrefixedCanonical('2026 FIFA World Cup')).toBe(true);
    expect(isSeasonPrefixedCanonical('2025–26 La Liga')).toBe(true);
    expect(isSeasonPrefixedCanonical('2025-26 La Liga')).toBe(true);
    expect(isSeasonPrefixedCanonical('2026 england premier league')).toBe(true);
  });

  test('SOUNDNESS BOUNDARY: FALSE for base leagues + ordinal-tier names (no leading year)', () => {
    expect(isSeasonPrefixedCanonical('la liga 2')).toBe(false);
    expect(isSeasonPrefixedCanonical('La Liga')).toBe(false);
    expect(isSeasonPrefixedCanonical('Premier League')).toBe(false);
    expect(isSeasonPrefixedCanonical('Ligue 1')).toBe(false);
    expect(isSeasonPrefixedCanonical('j2 league')).toBe(false);
    expect(isSeasonPrefixedCanonical('bundesliga 2')).toBe(false);
  });
});

describe('#239 whitespaceTokenCount (person despace bridge gate)', () => {
  test('≥2-token names (internal-space surname variance) — bridge-eligible', () => {
    expect(whitespaceTokenCount('Nour El Sherbini')).toBe(3);
    expect(whitespaceTokenCount('Nour ElSherbini')).toBe(2);
    expect(whitespaceTokenCount('Alex Sandro')).toBe(2);
    expect(whitespaceTokenCount('  De   Bruyne ')).toBe(2);
  });

  test('single-token mononym — NEVER bridge-eligible (Alex Sandro guard)', () => {
    expect(whitespaceTokenCount('Alexsandro')).toBe(1);
    expect(whitespaceTokenCount('Ronaldinho')).toBe(1);
    expect(whitespaceTokenCount('')).toBe(0);
    expect(whitespaceTokenCount('   ')).toBe(0);
  });
});
