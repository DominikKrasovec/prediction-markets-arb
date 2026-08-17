/** Placeholder-outcome detection: generic TBD slots ("Chef A", "Team 12") that inflate embedding distance and inject phantom Ω nodes. */
const PLACEHOLDER_NOUN =
  'chef|team|player|contestant|driver|candidate|entrant|golfer|wrestler|fighter|horse|car|option|side|entry';
const PLACEHOLDER_PARTICIPANT = new RegExp(`^(?:${PLACEHOLDER_NOUN})\\s+[a-z0-9]{1,2}$`, 'i');
const PLACEHOLDER_MISC = /^(?:the field|another|other|tbd|n\/a)$/i;
const PLACEHOLDER_CHILD = new RegExp(`\\b(?:${PLACEHOLDER_NOUN})\\s+[a-z0-9]{1,2}\\b`, 'i');

/** A participant label that is a generic TBD slot, not a real entity. */
export function isPlaceholderParticipant(name: string): boolean {
  const s = name.trim();
  return PLACEHOLDER_PARTICIPANT.test(s) || PLACEHOLDER_MISC.test(s);
}

/** A child-market title that is about a placeholder participant ("Will Team A win?"). */
export function isPlaceholderChild(title: string): boolean {
  return (
    PLACEHOLDER_CHILD.test(title) ||
    /\banother\s+\w+\s+(?:win|advance|finish|score)/i.test(title) ||
    /\bthe field\b/i.test(title)
  );
}

/** Drop placeholders, dedupe, sort — a deterministic participant list for embedding/Ω. */
export function cleanParticipants(participants: readonly string[] | null | undefined): string[] {
  if (!participants) return [];
  return [...new Set(participants.filter((p) => !isPlaceholderParticipant(p)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Drop placeholder children, then sort deterministically (kills cross-platform order drift). */
export function cleanSortChildren(children: readonly string[] | null | undefined): string[] {
  if (!children) return [];
  return children.filter((t) => !isPlaceholderChild(t)).slice().sort((a, b) => a.localeCompare(b));
}

// Ω placeholder detection is stricter + sequence-aware: a categorical outcome_set is a strict one-hot, so over-dropping (not over-keeping) manufactures a fake arb.
const OMEGA_PLACEHOLDER_NOUN =
  'chef|team|player|person|contestant|driver|candidate|entrant|golfer|wrestler|fighter|option|party';
const OMEGA_SLOT_RX = new RegExp(`^(${OMEGA_PLACEHOLDER_NOUN})\\s+([a-z]|[0-9]{1,2})$`, 'i');
// Noun-qualified (not bare `^another\b`); kept in sync with native-exclusivity.ts NATIVE_RESIDUAL_RX.
const OMEGA_RESIDUAL_RX =
  /^(?:other|the field|tbd|n\/a|draw|tie)$|\bends? in a (?:draw|tie)\b|\b(?:another (?:candidate|party|chef|team|player|contestant|driver|entrant|golfer|wrestler|fighter|option|nominee|name|club)|any other|the field)\b/i;

/** Anchored anonymized-slot test (no sibling-series requirement); normalizes `[_-]` to space so both label and slug forms match. */
export function isOmegaPlaceholderSlot(label: string | null | undefined): boolean {
  const s = (label ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return s !== '' && OMEGA_SLOT_RX.test(s);
}

// A fixture-shaped subject ("Brewers vs. Cubs") names the EVENT, not an entity — contradictory legs must never share identity through it.
const FIXTURE_SUBJECT_DELIM = '(vs\\.?|v\\.?|@|–|—|-)';
const FIXTURE_PLACEHOLDER_SUBJECT_RX = new RegExp(
  `^\\S+(\\s+\\S+)*\\s+${FIXTURE_SUBJECT_DELIM}\\s+\\S+(\\s+\\S+)*$`,
  'i',
);

// POSIX mirror for `~*`; kept byte-compatible with the regex above by placeholder-outcomes.test.ts.
export const FIXTURE_PLACEHOLDER_SUBJECT_SQL_RX =
  `^\\S+(\\s+\\S+)*\\s+${FIXTURE_SUBJECT_DELIM}\\s+\\S+(\\s+\\S+)*$`;

export function isFixturePlaceholderSubject(subject: string | null | undefined): boolean {
  const s = (subject ?? '').trim().replace(/\s+/g, ' ');
  return s !== '' && FIXTURE_PLACEHOLDER_SUBJECT_RX.test(s);
}

export function isFixturePlaceholderSubjectSql(expr: string): string {
  return `COALESCE(btrim(${expr}) ~* '${FIXTURE_PLACEHOLDER_SUBJECT_SQL_RX}', FALSE)`;
}

// NOT sequence-aware (unlike placeholderSlotsInSet) — deliberate, and must never be used to drop an Ω slot.
export const OMEGA_SLOT_SQL_RX = `^(${OMEGA_PLACEHOLDER_NOUN})\\s+([a-z]|[0-9]{1,2})$`;

export function isOmegaPlaceholderSlotSql(expr: string): string {
  return `COALESCE(btrim(regexp_replace(${expr}, '[_-]+', ' ', 'g')) ~* '${OMEGA_SLOT_SQL_RX}', FALSE)`;
}

export interface PlaceholderSetClassification<T> {
  drop: Set<T>;
  residual: Set<T>;
}

/** Sequence-aware placeholder classification for one outcome set; `label` must be the bare subject label, never the full title. */
export function placeholderSlotsInSet<T>(
  children: ReadonlyArray<{ id: T; label: string | null | undefined }>,
): PlaceholderSetClassification<T> {
  const drop = new Set<T>();
  const residual = new Set<T>();
  const stems = new Map<string, Map<string, T[]>>();

  for (const c of children) {
    const s = (c.label ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (!s) continue;
    if (OMEGA_RESIDUAL_RX.test(s)) {
      residual.add(c.id);
      continue;
    }
    const m = OMEGA_SLOT_RX.exec(s);
    if (!m) continue;
    const noun = m[1].toLowerCase();
    const idx = m[2].toLowerCase();
    let byIdx = stems.get(noun);
    if (!byIdx) {
      byIdx = new Map();
      stems.set(noun, byIdx);
    }
    const ids = byIdx.get(idx);
    if (ids) ids.push(c.id);
    else byIdx.set(idx, [c.id]);
  }

  // >=2 distinct index tokens per stem = a placeholder series (drop); a lone match is kept.
  for (const byIdx of stems.values()) {
    if (byIdx.size < 2) continue;
    for (const ids of byIdx.values()) for (const id of ids) drop.add(id);
  }
  return { drop, residual };
}
