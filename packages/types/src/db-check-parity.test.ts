/**
 * TS-const <-> init.sql CHECK parity.
 *
 * Pinned against the docker/init.sql CHECK text (file-based, no DB) so
 * `bun test` catches drift with no live Postgres. Each enum SoT const in
 * @arb/types that mirrors a DB CHECK is diffed, in both directions, against
 * every occurrence of that column's `CHECK (... col ... IN ( ... ))` list in
 * init.sql. A migration that widens a CHECK without updating the const here
 * (or vice versa) is a red.
 *
 * Duplicate-CHECK columns (grouping_type on markets + platform_events;
 * outcome_role on llm_market_normalizations + questions) are also pinned
 * against each other — the two occurrences must carry identical vocabularies.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GROUPING_TYPES, OUTCOME_ROLES, ARB_TYPES } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/types/src
const ROOT = join(HERE, '..', '..', '..'); // repo root
const INIT_SQL = readFileSync(join(ROOT, 'docker', 'init.sql'), 'utf8');

/**
 * Extract every `<column> IN ( ... )` value list from the init.sql text. Returns
 * one Set per occurrence (a column may appear in multiple tables). Line comments
 * (`-- ...`) inside the list are stripped before token extraction, and the DB
 * DEFAULT literal that precedes a CHECK is never captured (only the `<col> IN (`
 * group is). The `IN (...)` lists carry no nested parens, so a non-`)` capture is
 * exact.
 */
function checkInLists(col: string): Array<Set<string>> {
  const re = new RegExp(`${col}\\s+IN\\s*\\(([^)]*)\\)`, 'g');
  const out: Array<Set<string>> = [];
  for (const m of INIT_SQL.matchAll(re)) {
    const body = m[1]!.replace(/--[^\n]*/g, ''); // strip line comments
    const vals = new Set<string>();
    for (const t of body.matchAll(/'([a-z0-9_]+)'/g)) vals.add(t[1]!);
    out.push(vals);
  }
  return out;
}

function pin(col: string, tsConst: readonly string[], expectedOccurrences: number): void {
  const lists = checkInLists(col);
  it(`${col}: init.sql CHECK found in exactly ${expectedOccurrences} place(s)`, () => {
    expect(lists.length).toBe(expectedOccurrences);
  });
  const ts = new Set<string>(tsConst);
  lists.forEach((db, i) => {
    it(`${col}: occurrence #${i + 1} ↔ TS const (both directions)`, () => {
      const missingFromTs = [...db].filter((v) => !ts.has(v));
      const missingFromDb = [...ts].filter((v) => !db.has(v));
      expect({ missingFromTs, missingFromDb }).toEqual({ missingFromTs: [], missingFromDb: [] });
    });
  });
  if (expectedOccurrences > 1) {
    it(`${col}: all ${expectedOccurrences} CHECK occurrences are lock-step identical`, () => {
      const first = lists[0]!;
      for (const other of lists.slice(1)) {
        expect([...other].sort()).toEqual([...first].sort());
      }
    });
  }
}

describe('TS enum SoT ↔ init.sql CHECK parity', () => {
  // grouping_type: markets + platform_events (2 CHECKs, must be identical).
  pin('grouping_type', GROUPING_TYPES, 2);
  // outcome_role: llm_market_normalizations + questions (2 CHECKs, identical).
  pin('outcome_role', OUTCOME_ROLES, 2);
  // arb_type: arbitrage_opportunities (1 CHECK).
  pin('arb_type', ARB_TYPES, 1);
});
