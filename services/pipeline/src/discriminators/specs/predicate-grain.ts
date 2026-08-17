// Guard-only, not a fold key: refuses a Stage-3 leg merge when two legs stamp known,
// different `<family>:<grain>` settlement verbs (arrest≠charge, announce≠release, …).
// Single-grain-or-null: zero or more than one distinct grain in the text yields null,
// never a guess; nullPolicy 'tolerant' means an unstamped leg never blocks a merge.
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

// Each regex is anchored to the settlement VERB PHRASE, not a bare stem, to avoid
// incidental matches ("in charge of", "press release", "primary care").
export const PREDICATE_GRAIN_VOCAB: ReadonlyArray<readonly [family: string, grain: string, rx: RegExp]> = [
  ['legal_action', 'arrest', /\barrest(?:ed|s|ing)?\b/i],
  ['legal_action', 'charge', /\bcharged\s+with\b|\b(?:criminal|federal|felony)\s+charges?\b|\bfac(?:e|es|ing)\s+(?:criminal\s+|federal\s+)?charges?\b|\bbe\s+charged\b/i],
  ['legal_action', 'indict', /\bindict(?:ed|ment|ments|s)?\b/i],
  ['legal_action', 'convict', /\bconvict(?:ed|ion|ions|s)?\b/i],
  ['legal_action', 'sentence', /\bsentenc(?:ed|ing)\b|\bprison\s+sentence\b|\bsentenced\s+to\b/i],
  ['legal_action', 'release-from-custody', /\breleas(?:e|ed|es|ing)\b[\s\S]{0,25}?\bfrom\s+(?:prison|jail|custody|detention|incarceration)\b/i],
  ['publication', 'announce', /\bannounce(?:d|s|ment|ments)?\b|\bunveil(?:ed|s|ing)?\b/i],
  // Mirrors the negative-lookahead on legal_action:release-from-custody above — edit both
  // together, or "released from prison" double-stamps both grains and the gate goes null.
  ['publication', 'release', /\brelease(?:d|s)?\b(?![\s\S]{0,25}?\bfrom\s+(?:prison|jail|custody|detention|incarceration)\b)/i],
  ['publication', 'launch', /\blaunch(?:ed|es|ing)?\b/i],
  ['enactment', 'adopt', /\badopt(?:ed|s|ing)?\b(?=[\s\S]*\b(?:map|maps|redistrict\w*|district\w*|plan|boundar\w+)\b)/i],
  ['enactment', 'redistrict', /\bredistrict\w*\b/i],
  ['enactment', 'use', /\b(?:use[sd]?|using|in\s+effect|enacted)\b(?=[\s\S]*\b(?:map|maps|new\s+map|congressional\s+map)\b)|\bnew\s+map\s+(?:be\s+)?used\b/i],
  ['involvement', 'testify', /\btestif(?:y|ies|ied|ying)\b|\btestimony\b/i],
  ['involvement', 'named', /\bnamed\s+in\b|\bmentioned\s+in\b|\bappears?\s+(?:in|on)\b[\s\S]{0,25}\b(?:document|documents|file|files|list)\b|\bepstein\s+(?:files?|list|documents?)\b/i],
  ['departure', 'resign', /\bresign(?:ed|s|ation)?\b|\bsteps?\s+down\b|\bstepped\s+down\b/i],
  ['departure', 'out', /\bbe\s+out\s+as\b|\bout\s+as\s+(?:the\s+)?[\w\s]{0,25}\b(?:manager|coach|ceo|director|chief|head)\b|\b(?:fired|ousted|removed\s+as|forced\s+out)\b|\bor\s+(?:be\s+)?removed\b/i],
  ['election_stage', 'primary', /\b(?:presidential|senate|house|gubernatorial|congressional|party|republican|democratic|gop|dnc|rnc)\s+primary\b|\bprimary\s+(?:election|winner|runoff|for\s+(?:the\s+)?(?:senate|house|governor|president))\b|\bwin[s]?\s+(?:the\s+)?[\w\s]{0,25}\bprimary\b/i],
  ['election_stage', 'general', /\bgeneral\s+election\b/i],
  ['election_stage', 'runoff', /\brun-?off\b/i],
  ['election_stage', 'ballot', /\bon\s+the\s+ballot\b|\bballot\s+access\b|\bqualif(?:y|ies|ied)\s+for\s+the\s+ballot\b/i],
  ['diplomacy', 'deal', /\bnuclear\s+deal\b|\b(?:reach(?:es|ed|ing)?|sign(?:s|ed|ing)?|strike[sd]?)\s+a\s+(?:nuclear\s+|peace\s+|trade\s+|ceasefire\s+)?(?:deal|agreement|accord|pact)\b/i],
  ['diplomacy', 'weapon', /\bnuclear\s+weapons?\b|\bnuclear\s+bombs?\b|\batomic\s+bombs?\b|\b(?:acquire|obtain|build|develop|test|detonate)s?\s+(?:a\s+)?(?:nuclear\s+)?(?:weapon|bomb)\b/i],
  // `cut` excludes any title carrying emergency/intermeeting via a negative-lookahead
  // mirroring emergency-cut above, so the two grains stay mutually exclusive (never both).
  ['rate_action', 'emergency-cut', /\bemergency\s+(?:rate\s+)?(?:cut|reduction)\b|\bintermeeting\s+(?:rate\s+)?cut\b/i],
  ['rate_action', 'cut', /^(?!.*\b(?:emergency|intermeeting)\b).*\b(?:rate\s+cut|cut(?:s|ting)?\s+(?:interest\s+)?rates?|cut(?:s|ting)?\s+(?:the\s+)?(?:federal\s+funds|fed\s+funds|policy)\s+rate)\b/is],
  ['geo_scope', 'us', /\b(?:u\.?s\.?|united\s+states|american|domestic)\s+(?:recession|box\s+office|gdp|economy|record|gross|debut|opening)\b|\b(?:recession|box\s+office|record|number\s+one|no\.?\s*1)\s+in\s+the\s+(?:u\.?s\.?|united\s+states|us)\b/i],
  ['geo_scope', 'global', /\b(?:global|worldwide|international)\s+(?:recession|box\s+office|gdp|economy|record|gross|debut|opening)\b|\b(?:recession|box\s+office|record|gross)\s+(?:worldwide|globally|internationally)\b/i],
];

export function extractPredicateGrainFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const found = new Set<string>();
  for (const [family, grain, rx] of PREDICATE_GRAIN_VOCAB) {
    if (rx.test(text)) found.add(`${family}:${grain}`);
  }
  return found.size === 1 ? [...found][0] : null;
}

// Scans title + canonical_subject + outcome_label as one blob (PM/Predict group-item
// binaries can carry the verb in the label instead of the title).
export function extractPredicateGrain(ctx: ExtractCtx): string | null {
  const parts = [
    ctx.title,
    (ctx.gated.canonical_subject as string | null) ?? null,
    ctx.outcomeLabel,
  ].filter((s): s is string => !!s);
  return extractPredicateGrainFromText(parts.join('  '));
}

export const predicateGrainSpec: DiscriminatorSpec = {
  name: 'predicate_grain',
  kinds: 'all',
  source: 'title-regex',
  extract: extractPredicateGrain,
  assertion: 'guard-only',
  nullPolicy: 'tolerant',
};
