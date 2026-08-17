/**
 * Settlement-equivalence idiom bridge for the Stage-3 leg-coherence guards: platforms
 * spell one outcome with different idioms (`tie` vs `draw`, `nrfi` vs `no run first
 * inning`), which the plain alias fold doesn't know, false-dropping a correct leg.
 * Every fold is settlement-equivalent (same metric AND polarity). Pure and total.
 */
import { DRAW_TOKENS, DRAW_AXIS_KINDS } from '../../discriminators/specs/draw-axis.js';

export interface IdiomCtx {
  eventKind?: string | null;
  sport?: string | null;
  resolutionScope?: string | null;
}

/** Sentinel prefix for an idiom token; a folded label key can never contain '#'. */
const IDIOM = '#';

const DRAW_AXIS_KIND_SET: ReadonlySet<string> = new Set(DRAW_AXIS_KINDS as readonly string[]);

function scopeAllowsDraw(scope: string | null | undefined): boolean {
  return scope !== 'incl_overtime';
}

function isCricket(sport: string | null | undefined): boolean {
  return sport != null && sport.toLowerCase().includes('cricket');
}

function isDrawToken(folded: string): boolean {
  return DRAW_TOKENS.has(folded);
}

const NRFI_NO_RUN: ReadonlySet<string> = new Set([
  'nrfi',
  'no run first inning',
  'no runs first inning',
  'no run in first inning',
  'no runs in first inning',
  'no run scored in first inning',
  'no runs scored in first inning',
  'no run scored in the first inning',
  'no runs scored in the first inning',
  '0 runs first inning',
  'no run first inning yes',
]);
const NRFI_RUN: ReadonlySet<string> = new Set([
  'yrfi',
  'run scored in first inning',
  'runs scored in first inning',
  'run scored in the first inning',
  'a run scored in first inning',
  'a run scored in the first inning',
  'will there be a run scored in the first inning',
  'will there be a run scored in first inning',
  'first inning run yes',
]);

const OU_TWO_SIDED_RX = /\b(?:o u|over under)\b/;
const OU_OVER_RX = /\bover\b/;
const OU_UNDER_RX = /\bunder\b/;
const DIGIT_RUN_RX = /\d+/g;
/** Words allowed in a PURE over/under line; any other token is a subject-carrying
 *  label ("arsenal over 2.5") and is left untouched (never an entity name). */
const OU_DESCRIPTOR_WORDS: ReadonlySet<string> = new Set([
  'o', 'u', 'over', 'under', 'total', 'totals',
  'goals', 'goal', 'runs', 'run', 'games', 'game', 'points', 'point',
  'rounds', 'round', 'corners', 'cards',
]);

function overUnderToken(folded: string): string | null {
  const twoSided = OU_TWO_SIDED_RX.test(folded);
  const hasOver = OU_OVER_RX.test(folded);
  const hasUnder = OU_UNDER_RX.test(folded);
  if (!twoSided && !hasOver && !hasUnder) return null;
  const tokens = folded.split(' ').filter(Boolean);
  const digits: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) { digits.push(t); continue; }
    if (!OU_DESCRIPTOR_WORDS.has(t)) return null;
  }
  if (digits.length === 0) return null;
  const dir = twoSided || (hasOver && hasUnder) ? 'ou' : hasOver ? 'over' : 'under';
  return `${IDIOM}ou:${dir}:${digits.join('.')}`;
}

/** Maps a folded label key to its idiom token, or returns it unchanged when no idiom
 *  applies. The returned token is '#'-prefixed iff an idiom fired. */
export function expandLabelIdiom(folded: string, ctx?: IdiomCtx): string {
  if (!folded) return folded;

  if (isDrawToken(folded)) {
    const kindOk = ctx?.eventKind != null && DRAW_AXIS_KIND_SET.has(ctx.eventKind);
    if (kindOk && !isCricket(ctx?.sport) && scopeAllowsDraw(ctx?.resolutionScope)) {
      return `${IDIOM}draw`;
    }
    return folded;
  }

  if (NRFI_NO_RUN.has(folded)) return `${IDIOM}nrfi:no_run`;
  if (NRFI_RUN.has(folded)) return `${IDIOM}nrfi:run`;

  const ou = overUnderToken(folded);
  if (ou) return ou;

  return folded;
}

/** TRUE iff two folded label keys expand to the same '#'-prefixed idiom token. */
export function idiomsAgree(a: string | null | undefined, b: string | null | undefined, ctx?: IdiomCtx): boolean {
  if (a == null || b == null) return false;
  const ea = expandLabelIdiom(a, ctx);
  if (!ea.startsWith(IDIOM)) return false;
  return ea === expandLabelIdiom(b, ctx);
}
