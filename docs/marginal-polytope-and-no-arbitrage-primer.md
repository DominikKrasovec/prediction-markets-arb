# The marginal polytope & no-arbitrage — a primer for this engine

*Why this doc:* our arb-solver is an **LP over the outcome space (Ω)**, and the structural
edge graph is a set of coherence constraints over that space. Both are concrete instances
of a piece of theory from the combinatorial-market-maker literature (Hanson's LMSR,
Abernethy et al.'s no-arbitrage characterization, Dudík et al.'s constrained market maker,
Guo–Pennock event hierarchies). This primer explains that theory from the ground up and
maps each piece onto what we actually build, so the design language ("facets", "inner
approximation", "the polytope is too tight") is shared and precise.

The running example is a single soccer match; everything generalizes.

---

## 1. Securities, worlds, payoff vectors

Take a match and some of its markets as **binary securities** (each pays **$1 if YES**, else $0):

```
s1 = Home win   s2 = Draw   s3 = Away win
s4 = Over 2.5   s5 = BTTS   s6 = exact score 2-1   …
```

A **world** ω is one fully-resolved reality. The world "Home wins 2–1" gives the payoff vector

```
          s1 s2 s3 s4 s5 s6
x(2-1) = [ 1  0  0  1  1  1 ]   (home win ✓, 3 goals → over 2.5 ✓, both scored → BTTS ✓, 2-1 ✓)
x(1-0) = [ 1  0  0  0  0  0 ]
x(0-0) = [ 0  1  0  0  0  0 ]
```

**Ω** = the set of all *logically possible* worlds. Each is a 0/1 corner of the cube
`{0,1}^N` (N securities). Crucially, **not every corner is a valid world**: `[1,1,0,…]`
(home win *and* draw) is impossible — those events are mutually exclusive.

## 2. Prices are expected payoffs

A price `p_i ∈ [0,1]` is what one share costs. Under a coherent belief (a probability
distribution over the *valid* worlds), the fair price of a security is its probability of
paying out — i.e. its **expected payoff**:

```
p = Σ_ω  Prob(ω) · x(ω)
```

So **a price vector is "coherent" exactly when it is a convex combination (weighted average)
of valid-world payoff vectors.** That single fact is the whole game.

## 3. The marginal polytope

> **M = conv{ x(ω) : ω ∈ Ω }** — the convex hull of the valid-world payoff vectors.

Geometrically: take all valid corners of the cube and fill in the solid shape they span.
**M is the set of all coherent price vectors.** Every point inside M is achievable by *some*
probability distribution over real worlds; every point outside is not. (In the
graphical-models / ML literature this object is the **marginal polytope**; for binary
variables it is affinely the **correlation polytope**.)

## 4. The no-arbitrage theorem (the punchline)

A **portfolio** is a vector `q` (how many of each security you buy; negative = sell). Its
**cost** is `p·q`; its **payoff in world ω** is `x(ω)·q`. An **arbitrage** is a `q` whose
cost is below its *worst-case* payoff:

```
p·q  <  min_ω  x(ω)·q          → risk-free profit (a "dutch book")
```

The theorem (Abernethy–Chen–Wortman Vaughan, and the classical finance version):

> **A price vector p admits no arbitrage  ⟺  p ∈ M.**

Why: if `p ∉ M`, the separating-hyperplane theorem gives a direction `q` with
`p·q < x(ω)·q` for *every* valid world ω — that direction **is** the arbitrage portfolio.
If `p ∈ M`, no separating direction exists. **Arbitrage is literally "the price vector has
left the polytope," and the arb trade is the separating hyperplane.**

**Our Ω-LP *is* this test.** `buildLP` minimizes `p·q` subject to `x(ω)·q ≥ 1` in every
enumerated world; `optimalCost < 1` means a separating direction exists → `p ∉ M` → dutch
book. So the solver is a marginal-polytope no-arb test, not a metaphor.

## 5. Facets = the walls of M = our coherence constraints

A polytope can be described two equivalent ways: by its **vertices** (the valid worlds) or
by its **facets** (the linear inequalities — the flat walls — that bound it). Each facet is
a coherence rule. In the soccer example the walls of M include:

| Facet (wall of M)                                  | Our edge / set type        |
|----------------------------------------------------|----------------------------|
| `p(Home) ≥ p(2-1)`  (scoreline implies winner)     | `strict_implication`       |
| `p(Home) + p(Draw) + p(Away) = 1`                  | categorical `Σ=1`          |
| `p(Home) + p(Draw) ≤ 1`  (can't both happen)       | `mutual_exclusion`         |
| `p(A) = p(B)`  (same event, two venues)            | `equivalence`              |
| nested `p(≥3 goals) ≤ p(≥2 goals)`                 | threshold ladder           |

**Our three edge families plus the set-partition shapes (Σ=1, Σ≤1, ladder) are a
vocabulary for drawing facets of M.** Every edge we assert declares one wall.

## 6. Why nobody computes M exactly (the hardness)

For one match M is small. But the real Ω is the **product across all questions** — every
team, tournament, election. That M has a number of vertices and facets exponential in the
number of questions, and the walls take complicated forms. Concretely:

- **Testing membership** ("is this price vector in M?") is **NP-complete** in general, and
  identifying facets is believed even harder.
- Maintaining correct **LMSR** prices over such a space is **#P-hard, even for severely
  restricted bet languages** (Chen et al., *Complexity of Combinatorial Market Makers*).

**This is why Polymarket runs independent order books per question instead of one coherent
maker** — and that gap is precisely the combinatorial arb the empirical literature measures.
Two responses exist: Abernethy et al. **relax** no-arbitrage (bounded-loss convex cost over
a tractable set); Dudík–Lahaie–Pennock keep no-arb but **represent M by its facets and
generate them lazily** (constraint generation), never enumerating worlds.

## 7. The "other facets" — walls our edge vocabulary can't draw

Our vocabulary draws **pairwise** walls (implication / mutex / equivalence between *two*
securities) and **set-sum** walls with right-hand side ≤ 1 or = 1. The true M has walls
that are **genuinely k-ary (3+ securities)** and **don't decompose into pairwise**. Four
concrete, domain-real examples:

**(a) "At most k of n" — `Σ ≤ k` with k ≥ 2.** A group stage where **2 of 4 teams advance**:
```
p(T1 adv) + p(T2 adv) + p(T3 adv) + p(T4 adv) ≤ 2
```
No *pair* of those is mutually exclusive (any two can both advance), so **pairwise mutex
sees nothing** — yet if the four are priced 0.6 each (sum 2.4 > 2), that's a dutch book.
Our `Σ≤1` mutex and `Σ=1` categorical are the **k=1** special case; **k ≥ 2 is
inexpressible**, and tournaments are full of it ("N teams qualify", "top 4 make the
playoffs").

**(b) Multi-antecedent implication — `p(C) ≥ p(A) + p(B) − 1`.** Two-leg tie: *if X wins
leg 1 **and** leg 2, X advances*:
```
p(X advances) ≥ p(X wins leg1) + p(X wins leg2) − 1
```
This 3-variable wall (a Boole/Bonferroni inequality) is **not** the conjunction of any two
pairwise implications.

**(c) Exhaustive *equality* vs one-sided *implication*.** Our `exact_score ⟹ winner` edges
give the **lower** half:
```
p(Home win) ≥ Σ_{home-ahead scores} p(score)      ✓ we have this
```
but the true facet is the **equality** — home-win prob *equals* the sum over **all**
home-winning scorelines:
```
p(Home win) = Σ_{home-ahead scores} p(score)
```
The **upper** half (`≤`, which fires when the winner is *over*priced relative to the listed
scores) only holds if the exact-score market is **exhaustive** (has an "any other score"
residual). Pairwise implication can't encode "…and these are *all* the ways", so we catch
winner-underpriced arbs and **miss winner-overpriced** ones.

**(d) Conjunction / parlay facets (the full correlation polytope).** The moment you trade
**"A and B"** as one security (same-game parlays), the no-arb region becomes the
**correlation polytope**, whose walls include **triangle/cycle inequalities** like
```
p(A) + p(B) + p(C) − p(A∧B) − p(A∧C) − p(B∧C) ≤ 1
```
These are the canonical facets of arbitrary form; membership is NP-complete and pricing is
the #P-hard/NP-hard case. **This is why we purged multi-leg parlays** — handling them
*soundly* means living in the correlation polytope, the genuinely intractable regime.

> **Live worked example (the S4 / ballot fix, 2026-06-14).** Our equivalence builder had
> drawn `"X on the ballot" ≡ "X wins"` for 8 French-2027 markets. But "on the ballot" is a
> **precondition** of winning — `win ⟹ on-ballot`, an *implication*, not an equivalence
> (`win` is necessary-not-sufficient'd by `ballot`). The `≡` wall **forbids the perfectly
> real world {on-ballot = YES, win = NO}** — a wall that shouldn't exist → the polytope is
> too **tight** → a hard fake arb. Guard S4 removes that wall. (The sound `win ⟹ ballot`
> wall — a one-directional implication facet — is a recall follow-up.)

## 8. Inner vs outer approximation — and why our error bias is safe

Stack this up and here is what our engine computes versus the true M:

- Our enumerate-then-LP builds an **inner description by vertices**: list the worlds we
  *believe* valid, then convex-hull them.
- **Miss a constraint** (incomplete recall) → we keep worlds that are actually impossible →
  **M_ours ⊋ M_true** → polytope too **loose** → we **miss real arbs** but never invent
  one. *Safe direction.*
- **Assert a wrong constraint** (an unsound edge, e.g. a false equivalence or the ballot
  `≡`) → we delete a world that was actually possible → **M_ours ⊊ M_true** → polytope too
  **tight** → **fake arb**. *Unsafe direction.*

Our whole soundness program — `Σ=1 → Σ≤1` fail-safe, GATE-0 forcing `FALSE` when migration
061 is absent, `isExhaustive ?? false`, soft edges not pruning, every guard in
`equivalence-edge.ts` — engineers the errors into the **loose/safe** direction. The unsound
classes (false equivalences, hetero Σ=1, the ballot `≡`) are exactly the ones that slip
into the **tight/unsafe** direction. The entire game in one sentence: **keep the polytope an
inner-safe over-approximation, and treat every fake-arb bug as "a wall we drew that
shouldn't be there."**

## 9. The `n>30` truncation — and the architectural alternative

The `n>30` / `MAX_VALID_STATES = 10,000` truncation in `state-enumerator.ts` is a direct
consequence of representing M **by its vertices**: a connected cluster of `n` free binary
questions has up to `2^n` worlds, so we cap enumeration and a too-large cluster returns `[]`
(no arb states — a **recall** hole, never a fake arb). Measured live (2026-06-14): it fires
on 23 of 17,819 clusters today — the FIFA WC2026 (797 questions), NCAA 2027 (335 free), and
Eurovision/election complexes — exactly the densest combinatorial objects.

The structural fix is the one the literature uses: **stop enumerating vertices; represent M
by its facets and solve a linear feasibility LP** (Dudík-style constraint generation). That
single swap (enumerate-then-LP → constraint-matrix LP) **simultaneously** lifts the `2^n`
truncation *and* lets you express the k-ary facets from §7 the current vocabulary can't.
The substrate it would consume (deterministic, field-gated coherence rules) already exists;
the delta is the solver, not the rule layer.

A cheaper, partial version that needs no architecture change: a mutex *group* currently
encoded as pairwise `cross_question_mutex` edges blows up to `2^k`; modeled instead as **one
non-exhaustive categorical outcome_set** it is `O(k)`. Converting those (Eurovision Televote,
election fields) un-drops several truncated clusters at zero soundness cost.

## 10. Why the facet form is `n`, not `2^n`

The whole gain rests on one fact from computational geometry: **a polytope has two
descriptions, and they can be exponentially different in size.**

- **V-representation** — list its *vertices* (corners).
- **H-representation** — list its *facets* (the bounding inequalities / walls).

The cleanest example is a cube. An **n-dimensional cube has `2^n` vertices but only `2n`
facets**:

```
n independent yes/no questions  →  state space = the n-cube
   vertices (corners) = every YES/NO combination          = 2^n
   facets  (walls)    = "0 ≤ p_i ≤ 1" for each question i  = 2n
```

Map that onto the two solvers:

- **Current = V-representation.** `state-enumerator.ts` lists the valid worlds (corners),
  and `lp-builder.ts` emits **one LP constraint row per world** ("the portfolio must pay
  ≥ $1 in this world"). So the LP has up to `2^n` rows — **LP size = vertex count.** That is
  the `2^n`.
- **Proposed = H-representation.** Write the coherence constraints *directly as
  inequalities* — **one LP row per facet** — so the LP has `O(n)` rows. **LP size = facet
  count.** That is the `n`.

Why you don't need to list the worlds: the no-arbitrage test "is the price vector `p`
inside `M`?" has two equivalent answers — *"is `p` a blend of the vertices?"* (needs all
`2^n` vertices) **or** *"does `p` satisfy every facet inequality?"* (needs only the facets).
A single facet like `Σ ≤ 2` ("at most 2 advance") constrains *all* the worlds at once, so
you never enumerate them. Concretely, "at most 2 of 4 advance": the V-rep lists the
`C(4,0)+C(4,1)+C(4,2) = 11` valid worlds; the H-rep is the **one** inequality
`p₁+p₂+p₃+p₄ ≤ 2`. The live NCAA cluster: `2^335` worlds → ~336 inequalities (335
"qualify ⟹ …" implications + 1 categorical).

The caveat (so the win isn't oversold): *some* polytopes have exponentially many facets too
— the parlay / correlation-polytope case (§7d). There you use **constraint generation**:
start with a few inequalities, solve, and whenever the answer violates an inequality you
haven't added yet, add just that one and re-solve — provably few rounds for "nice"
polytopes. But our staple constraints (implications, mutex, sums, ladders) are each *one*
inequality and there are only polynomially many, so for us the H-rep is simply small.

## 11. Adding a new constraint family — the two-layer pattern

You don't teach the solver to "discover" new arbitrage types. You keep the **same two-layer
split the engine already uses** (edge builders + per-type handling), generalized from
"prune the enumerated worlds" to "emit an inequality":

**Layer 1 — the pipeline emits a *typed, parameterized constraint*.** Today an edge row is
`(antecedent, consequent, edge_type, pattern)` and the solver branches on the type. The
three k-ary facets from §7 slot in the same way — two of them need a richer shape than the
strictly-*pairwise* `implication_edges` table (one antecedent, one consequent):

| New facet | What it needs in the structure layer | Detector |
|---|---|---|
| **k-of-n** (`Σ ≤ k`) | a new `outcome_set` kind, e.g. `set_type='bounded'` with a stored `k` | reads the tournament `format_spec` ("M of N advance") — already present for WC2026 |
| **multi-antecedent** (`p_C ≥ p_A + p_B − 1`) | a **hyperedge**: two antecedents → one consequent. The pairwise edge table can't hold it — needs a new table or a JSON antecedent list | detects "both legs required" / two-leg-tie structures |
| **exhaustive equality** (`p_W = Σ p_score`) | *no new shape* — reuses the `is_exhaustive` flag we already track on the score set | extend `exact-score-derived.ts`: when the score set is exhaustive, also emit the `≤` arm |

**Layer 2 — the solver holds a small "constraint-type → LP-inequality" translation table.**
This is how it knows "what's what": the type tag — exactly as `state-enumerator.ts` branches
on `edge_type` / `set_type` today. In the facet-LP each tag maps to a row instead of to a
world-pruning rule:

```
strict_implication (A⟹B)     →   p_A − p_B          ≤ 0
mutual_exclusion {A,B}        →   p_A + p_B          ≤ 1
categorical Σ=1               →   Σ p_i             =  1
k-of-n            (NEW)       →   Σ p_i             ≤  k
multi-antecedent (NEW)        →   p_A + p_B − p_C    ≤ 1
exhaustive equality (NEW)     →   p_W − Σ p_score   =  0
```

So adding an arbitrage type is mechanical: **(1) build a Stage-4 detector that emits the
tagged constraint, and (2) add one row to the solver's translation table.** The solver never
infers semantics — the pipeline labels each constraint, the solver translates the label to
an inequality. Most existing builders (implications, mutex, equivalence) already emit exactly
what Layer 1 needs; the genuinely new work is the **bounded (`k-of-n`) set kind**, the
**hyperedge table** for multi-antecedent, and flipping on the **exhaustive-equality** arm we
already have the flag for.

## 12. Integrality — when one facet *exactly* replaces `2^n` worlds (and when it's only safe)

§10 showed the facet form is O(n) in *size*. This section is the correctness
companion: it explains **when the facet LP gives the identical answer to the
world-enumeration LP, and when it gives only a safe (conservative)
approximation.** The single property that decides it is called **integrality**.
(Everything here was validated empirically — see §13.)

### 12.1 Why facets can replace worlds at all (the relaxation trick)

The arb test asks: *does my basket pay ≥ \$1 in **every** valid world?* A world is
a 0/1 vector `z` (one coordinate per question, `1` = resolves YES). The basket's
payoff in world `z` is a **linear** function `C + w·z` (derived in the stress
audit). So:

> "pay ≥ 1 in every world" ⟺ "pay ≥ 1 in the **worst** world" ⟺ "the **minimum**
> of a linear function over the set of valid worlds is ≥ 1".

And minimizing a linear function over a set of points equals minimizing over their
**convex hull** — a polytope. So you replace *"check all `2^n` worlds"* with
*"solve one small LP: minimize `w·z` over the polytope, check it's ≥ 1."* That
single substitution is the entire V-rep → H-rep reduction. The polytope's facets
(the coherence inequalities) are all that LP needs.

### 12.2 The catch: fractional corners

When you describe the polytope by its facets (`Gz ≤ g`, `0 ≤ z ≤ 1`) and minimize
over it, an LP always returns a **corner (vertex)** of the polytope. But a corner
of the *continuous* facet-region can be **fractional** — a point like
`z = (½, ½, …)` that is **not a real world** (no question is "half-YES"). If the
worst point of the continuous region is fractional, the facet LP is demanding the
basket also cover a world that can never occur. That makes it **stricter than
reality** — it can *fail to find* a real arb, but it can never *invent* one.

### 12.3 Integral polytope = every corner is a real world

A polytope is **integral** when *every* vertex has all-integer (here 0/1)
coordinates — i.e. **every corner already is a real world**. For an integral
polytope the LP minimum lands on a genuine world, so:

> **integral ⟹ facet LP answer = world-enumeration answer, exactly.**
> **non-integral ⟹ facet LP is a safe under-estimate (may miss arbs, never fakes one).**

### 12.4 Our staple constraints are integral (so the swap is free *and* exact)

| structure | polytope | why it's integral |
|---|---|---|
| **categorical** `Σ z = 1` | a *simplex* | its corners are the unit vectors = the one-hot worlds |
| **threshold ladder / implication forest** | the *order polytope* of a partial order | Stanley's theorem: its vertices are exactly the indicator vectors of the order's down-sets = the valid prefix/ideal worlds |
| **a single mutual-exclusion pair** `z_A+z_B ≤ 1` | a square corner | corners `00,10,01` are all 0/1 |

These cover essentially every constraint the engine emits today — which is why
the prototype matched the production solver **exactly** on all of them (§13).

### 12.5 The two structures that are *not* integral (and the fixes)

1. **A mutex *clique* written as pairwise edges.** If `k` outcomes are all
   mutually exclusive and you encode that as `C(k,2)` separate `z_i+z_j ≤ 1`
   constraints, the continuous region has a fractional corner `z = (½,…,½)`
   (every pair sums to 1, "half each") that is not a real world. This is the
   **stable-set polytope** of a graph, integral only for special ("perfect")
   graphs. **Fix:** model the whole group as **one** categorical `Σ z ≤ 1`. That
   single facet *is* integral — and smaller. So §9's "mutex-group → categorical"
   move fixes the non-integrality **and** the `2^k` size blow-up with one change.
2. **Correlation / parlay structure** (constraints that couple pairs, e.g. "A and
   B both happen"). This is the **correlation / cut polytope**, famously *not*
   integral, needing cycle/triangle inequalities and having exponentially many
   facets. This is the §7d caveat — handle it with **constraint generation** (add
   a violated inequality only when one is hit), never by listing all facets.

### 12.6 The safety guarantee

Crucially the error is **one-sided**. A non-integral facet LP *over*-constrains,
so it can only **miss an arb that exists** (a recall gap), never **report an arb
that isn't there** (a soundness break). That is the same inner/outer-approximation
safety as §8: we always sit on the side that cannot manufacture a fake guarantee.

## 13. Empirical validation (2026-06-15) — the prototype works

A working facet-LP prototype (`data/omega-stress/facet-lp.ts`) was built and run
**side-by-side with the production world-enumeration solver** on identical
clusters. Results, full write-up in
[`omega-lp-stress-audit-2026-06-15.md`](omega-lp-stress-audit-2026-06-15.md):

- **Exactness confirmed.** 13/13 clusters (categorical, threshold, implication
  chain, cartesian product, mutex; arb and no-arb) gave **byte-identical optimal
  cost** (Δ = 0) — the §12.4 integral cases, as predicted.
- **Feasibility confirmed.** It solved clusters the V-rep **drops** at the 10k
  cap: the 188-rung BTC ladder (`2^188` worlds → 189 inequalities, 13 ms) and the
  **335-rung NCAA chain** (`2^335` → 336 inequalities, 29 ms).
- **Speed.** 3×–19× faster on categoricals where both solve (k=64…1024), and the
  gap →∞ on the dropped clusters.
- **What the V-rep actually costs** (measured): real Ω is tiny (median **2**
  states, max **804**); the categorical regime real clusters live in crosses the
  1-second budget at **~800 states** (`nnz ≈ k²`); the LP-format string handed to
  HiGHS **aborts at ~100–170 MB**; enumeration **OOMs at ~2M states** (~2 KB per
  world); the 10k cap **drops the 23 densest clusters** (NCAA, WC2026). Every one
  of these is a V-representation artifact the facet form removes.

**Change size to adopt:** ~120 new + ~30 changed lines — a new `clusterToFacets`
+ `buildFacetLPString` module replacing `state-enumerator.ts` + `lp-builder.ts`
in the hot path; `solver.ts`, the price cache, the loader, and the basket
extraction are unchanged. It runs in shadow mode (both solvers, compare) before
cutover.

### 13.1 Further reading — how to investigate the theory

Terms to search, roughly in dependency order:

- **LP duality / Farkas' lemma** — the engine behind "minimize over a polytope"
  and the *certificate* that turns a violated facet into the actual arb basket.
- **Integral polytopes; totally unimodular (TU) matrices** — Hoffman–Kruskal:
  if a constraint matrix is TU, the polytope is integral for *every* integer
  right-hand side. (Implication/order constraints give TU-type systems.)
- **Order polytopes** — R. Stanley, *Two Poset Polytopes* (1986): why the valid
  worlds of an implication order are exactly an integral polytope's vertices.
- **Stable-set polytope, perfect graphs, the theta body** — why pairwise-mutex
  cliques are *not* integral and when they become so.
- **Correlation / cut polytope** — Deza & Laurent, *Geometry of Cuts and
  Metrics*; the cycle/triangle inequalities and why membership is NP-hard (the
  §7d parlay wall).
- **Robust linear optimization** — Ben-Tal, El Ghaoui & Nemirovski: the general
  "a constraint must hold for *all* `z` in a set → a finite, tractable LP"
  machinery that §12.1's reformulation is one instance of.
- **Birkhoff polytope** — a clean classical example of an integral polytope, good
  for intuition.
- **Dudík–Lahaie–Pennock constraint generation** (already cited) — the practical
  recipe for the non-integral / exponential-facet case.

---

## Sources

- J. Abernethy, Y. Chen, J. Wortman Vaughan — *Efficient Market Making via Convex
  Optimization, and a Connection to Online Learning* (ACM TEAC, 2013). The no-arbitrage =
  convex-hull characterization; cost function via convex conjugate.
- Y. Chen, L. Fortnow, et al. — *Complexity of Combinatorial Market Makers* (EC 2008,
  arXiv:0802.1362). LMSR pricing #P-hard; pair betting NP-hard.
- M. Dudík, S. Lahaie, D. Pennock — *A Tractable Combinatorial Market Maker Using
  Constraint Generation* (EC 2012). Facet/constraint-generation representation of M.
- M. Guo, D. Pennock — *Combinatorial Prediction Markets for Event Hierarchies* — brackets
  as event hierarchies.
- Background geometry: the correlation/cut polytope, its triangle/cycle inequalities, and
  the NP-completeness of membership.
- R. P. Stanley — *Two Poset Polytopes* (Discrete & Comput. Geometry, 1986). The order
  polytope; its vertices are exactly the down-sets of the poset (integrality of §12.4).
- A. Schrijver — *Theory of Linear and Integer Programming* (1986). Total unimodularity,
  the Hoffman–Kruskal integrality theorem, LP duality (the §12 machinery).
- M. M. Deza, M. Laurent — *Geometry of Cuts and Metrics* (1997). The cut/correlation
  polytope and its facet structure (the §7d / §12.5 non-integral case).
- A. Ben-Tal, L. El Ghaoui, A. Nemirovski — *Robust Optimization* (2009). The
  "constraint must hold for all `z` in a set → finite LP" reformulation used in §12.1.
