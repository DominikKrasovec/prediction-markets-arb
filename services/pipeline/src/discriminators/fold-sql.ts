// Stage-4 generated fold conjunct + set group-key surface: emits, per
// assertion:'fold-key' spec, the per-nullPolicy conjunct on discriminators JSONB.
import {
  foldKeySpecs, foldKeySpecsForSurface, setSplitSpecs, getSpec,
  type DiscriminatorSpec, type FoldSurface,
} from './registry.js';
import { bothKnownDifferSql } from '../util/sql-fragments.js';

export function discExpr(alias: string, spec: DiscriminatorSpec | string): string {
  const name = typeof spec === 'string' ? spec : spec.name;
  return `${alias}.discriminators->>'${name}'`;
}

export function nullPolicyConjunct(a: string, b: string, spec: DiscriminatorSpec): string {
  const ea = discExpr(a, spec);
  const eb = discExpr(b, spec);
  switch (spec.nullPolicy) {
    case 'strict':
      return `${ea} IS NOT DISTINCT FROM ${eb}`;
    case 'tolerant':
    case 'block-when-sibling-known':
      return bothKnownDifferSql(ea, eb);
  }
}

function foldFragmentFor(specs: DiscriminatorSpec[], a: string, b: string): string {
  if (specs.length === 0) return '';
  return specs.map((s) => nullPolicyConjunct(a, b, s)).join('\n       AND ');
}

export function discFoldFragment(a: string, b: string): string {
  return foldFragmentFor(foldKeySpecsForSurface('identity'), a, b);
}

export function builderDiscFoldFragment(a: string, b: string): string {
  return foldFragmentFor(foldKeySpecsForSurface('builder'), a, b);
}

export function foldSpecsOf(surface: FoldSurface): DiscriminatorSpec[] {
  return foldKeySpecsForSurface(surface);
}

// Throws on an unknown/non-fold-key name so a renamed spec fails the
// builder's tests instead of silently no-opping.
export function builderDiscConjunct(a: string, b: string, name: string): string {
  const spec = getSpec(name);
  if (!spec || spec.assertion !== 'fold-key') {
    throw new Error(`builderDiscConjunct: '${name}' is not a fold-key registry spec`);
  }
  return nullPolicyConjunct(a, b, spec);
}

// GROUP-BY key extension for set builders. Enumerates setSplitSpecs(), not
// every fold-key, since a blanket key would shatter sets that legitimately
// mix directions or parties.
export function setDiscKey(alias: string, scope: 'categorical' | 'threshold_series' = 'threshold_series'): string {
  const specs = setSplitSpecs().filter((s) => s.setSplit === 'all' || scope === 'threshold_series');
  const keys = specs.map((s) => discExpr(alias, s));
  return keys.length ? ', ' + keys.map((k) => `(${k})`).join(', ') : '';
}

// Set surface — finalize slot projections + TS key parts.
export function setSplitSlotProjectionsFeedA(normAlias: string, orderCol: string): string {
  return setSplitSpecs()
    .map((s) => `,
             (array_remove(array_agg(${normAlias}.discriminators->>'${s.name}' ORDER BY ${orderCol}), NULL))[1] AS disc_${s.name}`)
    .join('');
}

export function setSplitPassthroughCols(alias: string): string {
  return setSplitSpecs().map((s) => `,
           ${alias}.disc_${s.name}`).join('');
}

export function setSplitSlotProjectionsFeedB(normAlias: string): string {
  return setSplitSpecs()
    .map((s) => `,
           ${normAlias}.discriminators->>'${s.name}' AS disc_${s.name}`)
    .join('');
}

// Scope-aware: a 'threshold-only' spec contributes nothing on a categorical set.
export function slotSetSplitDisc(
  row: Record<string, unknown>,
  groupedAs: 'categorical' | 'threshold_series',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of setSplitSpecs()) {
    if (s.setSplit === 'threshold-only' && groupedAs !== 'threshold_series') continue;
    const v = row[`disc_${s.name}`];
    if (typeof v === 'string' && v !== '') out[s.name] = v;
  }
  return out;
}

export function setSplitKeyPart(
  row: Record<string, unknown>,
  groupedAs: 'categorical' | 'threshold_series',
): string {
  const disc = slotSetSplitDisc(row, groupedAs);
  return setSplitSpecs().map((s) => disc[s.name] ?? '').join('|');
}
