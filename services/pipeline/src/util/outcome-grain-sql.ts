/**
 * Generates the SQL mirror of `memberOutcomeGrain` directly from the RegExps
 * and Map it runs on (util/outcome-grain.ts), so a marker family added there
 * shows up here automatically instead of needing a hand-kept copy.
 *
 * Pure / deterministic — string building only, no DB.
 */
import {
  MEMBER_TITLE_GRAIN,
  MEMBER_TITLE_NEUTRAL_RX,
  MEMBER_KIND_GRAIN,
  type OutcomeGrain,
} from './outcome-grain.js';

/**
 * JS RegExp source to Postgres ARE literal body. `\b` is a backspace in
 * Postgres ARE; its word-boundary assertion is `\y`.
 */
function toPostgresAre(rx: RegExp): string {
  return rx.source.replace(/\\b/g, '\\y').replace(/'/g, "''");
}

function grainLiteral(g: OutcomeGrain): string {
  return `'${g.replace(/'/g, "''")}'`;
}

/**
 * A `CASE … END` expression yielding the member's outcome grain as TEXT, or
 * NULL when the classifier abstains. Follows the same decision order as
 * memberOutcomeGrain(title, event_kind): neutral/null check first, then the
 * title marker families, then event_kind as the secondary signal.
 */
export function memberOutcomeGrainSql(
  titleExpr: string,
  eventKindExpr: string,
  indent = '  ',
): string {
  const arms: string[] = [
    `WHEN ${titleExpr} ~* '${toPostgresAre(MEMBER_TITLE_NEUTRAL_RX)}' THEN NULL`,
    ...MEMBER_TITLE_GRAIN.map(([rx, g]) => `WHEN ${titleExpr} ~* '${toPostgresAre(rx)}' THEN ${grainLiteral(g)}`),
  ];
  // Groups event_kind arms by grain into one IN-list per grain; Map insertion
  // order keeps output stable across runs.
  const kindsByGrain = new Map<OutcomeGrain, string[]>();
  for (const [kind, g] of MEMBER_KIND_GRAIN) {
    const list = kindsByGrain.get(g);
    if (list) list.push(kind);
    else kindsByGrain.set(g, [kind]);
  }
  for (const [g, kinds] of kindsByGrain) {
    const inList = kinds.map((k) => `'${k.replace(/'/g, "''")}'`).join(',');
    arms.push(
      kinds.length === 1
        ? `WHEN ${eventKindExpr} = ${inList} THEN ${grainLiteral(g)}`
        : `WHEN ${eventKindExpr} IN (${inList}) THEN ${grainLiteral(g)}`,
    );
  }
  return `CASE\n${arms.map((a) => indent + a).join('\n')}\n${indent}ELSE NULL\n${indent}END`;
}
