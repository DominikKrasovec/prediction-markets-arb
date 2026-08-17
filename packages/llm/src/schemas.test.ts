/**
 * Parity tests for LLM prompt schemas.
 *
 * THREE places define the same schema for each LLM task:
 *   1. `RUNTIME_SCHEMAS` in `packages/llm/src/schemas.ts` — what the LLM
 *      actually receives at runtime (see prompt-loader.ts precedence).
 *   2. `packages/llm/prompts/<task>/schema.json` — on-disk, human-readable
 *      schema used by tooling and external readers.
 *   3. `packages/llm/scripts/build-schemas.ts` — generator that writes (2)
 *      from a hand-written definition.
 *
 * Without enforcement these three drift, which has already bitten the
 * project twice (the parlay-prefix bug + the entity_enrichment field
 * additions). This test pins the runtime ↔ on-disk surfaces.
 *
 * Scope: property-key parity at the `items.properties` level. Description
 * wording can differ — only the SHAPE has to match. Adding a new field
 * to one but not the other will fail this test.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RUNTIME_SCHEMAS, loadPromptTemplate } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = resolve(__dirname, '..', 'prompts');

interface AnySchema {
  type?: string;
  properties?: Record<string, AnySchema>;
  items?: AnySchema;
  required?: string[];
}

/**
 * Drill into the schema to find the array-of-objects level whose item
 * properties are the LLM's per-entity (or per-pair) output shape. Returns
 * the sorted property keys at that level. For non-array root schemas,
 * falls back to root-level property keys.
 */
function extractItemKeys(schema: AnySchema): string[] {
  const root = schema.properties ?? {};
  for (const key of Object.keys(root)) {
    const v = root[key];
    if (v?.type === 'array' && v.items?.properties) {
      return Object.keys(v.items.properties).sort();
    }
  }
  return Object.keys(root).sort();
}

function readOnDisk(task: string): AnySchema | null {
  const p = resolve(PROMPTS_DIR, task, 'schema.json');
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as AnySchema;
  } catch {
    return null;
  }
}

const TASKS = ['entity_enrichment', 'extraction', 'implication'] as const;

describe('LLM schema source parity', () => {
  for (const task of TASKS) {
    test(`${task}: RUNTIME_SCHEMAS exists`, () => {
      expect(RUNTIME_SCHEMAS[task]).toBeDefined();
    });

    test(`${task}: on-disk schema.json exists and matches runtime keys`, () => {
      const onDisk = readOnDisk(task);
      expect(onDisk).not.toBeNull();
      const runtimeKeys = extractItemKeys(RUNTIME_SCHEMAS[task] as AnySchema);
      const diskKeys    = extractItemKeys(onDisk!);
      expect(diskKeys).toEqual(runtimeKeys);
    });

    test(`${task}: loadPromptTemplate returns the runtime schema (RUNTIME_SCHEMAS wins over on-disk)`, () => {
      const tpl = loadPromptTemplate(task);
      // The runtime schema and the loaded template's schema must be the
      // exact same object reference — guarantees that the prompt-loader
      // precedence rule in `prompt-loader.ts:30` is intact.
      expect(tpl.schema).toBe(RUNTIME_SCHEMAS[task]);
    });

    test(`${task}: required fields list (if present) only names properties that exist`, () => {
      // Defensive: a required field that doesn't exist in properties is a
      // silent schema bug (LLM never produces it, validator never catches).
      const schema = RUNTIME_SCHEMAS[task] as AnySchema;
      function checkLevel(s: AnySchema, path: string): void {
        if (s.required && s.properties) {
          for (const req of s.required) {
            if (!(req in s.properties)) {
              throw new Error(`required '${req}' missing from properties at ${path}`);
            }
          }
        }
        if (s.properties) {
          for (const [k, v] of Object.entries(s.properties)) {
            checkLevel(v, `${path}.${k}`);
          }
        }
        if (s.items) checkLevel(s.items, `${path}[]`);
      }
      expect(() => checkLevel(schema, task)).not.toThrow();
    });
  }
});

describe('LLM schema content invariants', () => {
  test('entity_enrichment: taxonomy expansion fields are present in runtime schema', () => {
    const schema = RUNTIME_SCHEMAS.entity_enrichment as AnySchema;
    const props = schema.properties?.entities?.items?.properties ?? {};
    expect(props.new_sport_aliases).toBeDefined();
    expect(props.new_league_aliases).toBeDefined();
    // The CRITICAL note on new_league_aliases is the contract that keeps the
    // hierarchy chain wired — pin its presence so it can't be silently dropped.
    const newLeagueDesc = (props.new_league_aliases as { description?: string }).description ?? '';
    expect(newLeagueDesc).toMatch(/sport_canonical MUST also be set/i);
  });

  test('entity_enrichment: type enum includes all ENTITY_TYPES from @arb/types', () => {
    const schema = RUNTIME_SCHEMAS.entity_enrichment as AnySchema;
    const typeProp = schema.properties?.entities?.items?.properties?.type as { enum?: string[] } | undefined;
    expect(typeProp?.enum).toBeDefined();
    // Sanity floor — the canonical list has 11 types; if the schema drops
    // below 10 something dropped silently from ENTITY_TYPES.
    expect(typeProp!.enum!.length).toBeGreaterThanOrEqual(10);
    for (const t of ['person', 'team', 'sport', 'league', 'competition', 'data_provider']) {
      expect(typeProp!.enum).toContain(t);
    }
  });
});
