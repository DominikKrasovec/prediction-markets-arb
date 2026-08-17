/**
 * Subject aggregate-kind classifier.
 *
 * A `categorical_exclusive` set can fuse two partitions of one election — a
 * party-grain partition ({Democrat, Republican}) and a candidate-grain
 * partition ({Graham Platner, Janet Mills}) — into one 'winner' grain, even
 * though they genuinely co-resolve: "Democrat wins" and "Janet Mills wins"
 * are both YES when the Democratic nominee wins, since a candidate runs for
 * a party. An asserted Σ≤1 mutex across such a set is fake.
 *
 * This module maps a winner-grain slot to an aggregate kind so the mint path
 * can refuse a set that mixes an organization/party aggregate with a
 * politician member. Pure/deterministic — KB typing is looked up by the
 * caller (getSubjectTypings) and passed in.
 *
 * Gating scopes to role='politician' (not any person) because the
 * aggregate-vs-member containment that makes the mutex fake exists only for
 * a party and its candidate — non-political org+person mixes (a band among
 * solo artists, a venue prop among fighters) are not containment and must
 * stay sound. The KB carries no party-affiliation link, so a legitimate
 * party+independent-politician race is indistinguishable from a fake
 * party+own-candidate one; the mix is refused outright, conservative on
 * ambiguity, with the solver-side price belt as the residual guard for any
 * legitimate mix shape thus refused.
 */

/** One KB hit's classification-relevant fields (from getSubjectTypings). */
export interface SubjectTyping {
  type: string | null;
  role: string | null;
}

export type SubjectType = 'org' | 'politician' | 'person' | 'other';

/**
 * Candidate KB surface forms to type for one winner-grain slot. The org side is a
 * clean surface ("Democratic Party" → organization); the person side is often a
 * SYNTHETIC snake-case label with a `_wins`/`_win` predicate suffix
 * ('janet_mills_wins') and no outcome_subject, so we ALSO try the de-underscored
 * form ('janet mills wins') and a suffix-stripped form ('janet mills' → matches the
 * KB alias). Deterministic, deduped, lowercased. Pure.
 */
export function subjectTypeForms(
  subject: string | null | undefined,
  label: string | null | undefined,
  outcomeId: string,
): string[] {
  const out = new Set<string>();
  const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const push = (s: string | null | undefined) => {
    if (!s) return;
    const t = norm(s);
    if (t) out.add(t);
  };
  push(subject);
  for (const base of [label, outcomeId]) {
    if (!base) continue;
    push(base);
    const stripped = norm(base).replace(
      /\s+(?:wins?|to win|elected|victory|re[- ]?elected|re[- ]?election)$/,
      '',
    ).trim();
    push(stripped);
  }
  return [...out];
}

/**
 * Aggregate kind of one slot from its typed surface forms. `lookup(form)` returns
 * the KB typing of a form (undefined = no KB row). Precedence:
 *   organization/party  → 'org'      (the aggregate)
 *   person role politician → 'politician' (the containable election member)
 *   person (other role)  → 'person'  (a same-grain competitor, NOT containment)
 *   otherwise            → 'other'
 * `org` wins over `politician` so a party surface that also alias-hits a person is
 * treated as the aggregate (never seen live, but the conservative direction). Pure.
 */
export function classifyAggregateKind(
  forms: readonly string[],
  lookup: (form: string) => SubjectTyping | undefined,
): SubjectType {
  let sawPolitician = false;
  let sawPerson = false;
  for (const f of forms) {
    const hit = lookup(f);
    if (!hit) continue;
    if (hit.type === 'organization' || hit.type === 'party') return 'org';
    if (hit.type === 'person') {
      if (hit.role === 'politician') sawPolitician = true;
      else sawPerson = true;
    }
  }
  if (sawPolitician) return 'politician';
  if (sawPerson) return 'person';
  return 'other';
}

/**
 * TRUE iff the slot kinds mix an organization/party AGGREGATE with a POLITICIAN
 * member — the fake aggregate-vs-member election mutex (a party co-resolves YES
 * with its own candidate). Pure; the mint-path refusal signal.
 */
export function kindsMixOrgWithPolitician(kinds: readonly SubjectType[]): boolean {
  let org = false;
  let politician = false;
  for (const k of kinds) {
    if (k === 'org') org = true;
    else if (k === 'politician') politician = true;
  }
  return org && politician;
}
