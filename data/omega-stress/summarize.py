#!/usr/bin/env python3
"""Extract the headline numbers for the audit paper from the result CSVs."""
import json, os, math
import numpy as np, pandas as pd
RES = "data/omega-stress/results"


def load(n):
    p = f"{RES}/{n}"
    return pd.read_csv(p) if os.path.exists(p) else None


def cross(x, y, t):
    x = np.asarray(x, float); y = np.asarray(y, float)
    m = np.isfinite(y)
    x, y = x[m], y[m]
    if len(x) < 2: return None
    if (y < t).all(): return float(x.max())
    if (y >= t).all(): return None
    idx = np.where((y[:-1] < t) & (y[1:] >= t))[0]
    if len(idx) == 0: return float(x[y < t].max())
    i = idx[0]
    lx0, lx1 = math.log(x[i]), math.log(x[i+1])
    ly0, ly1 = math.log(max(y[i], 1e-9)), math.log(max(y[i+1], 1e-9))
    return float(math.exp(lx0 + (math.log(t)-ly0)*(lx1-lx0)/(ly1-ly0)))


def fnum(x):
    if x is None: return "—"
    if x >= 1e6: return f"{x/1e6:.2f}M"
    if x >= 1e3: return f"{x/1e3:.1f}k"
    return f"{x:.0f}"


print("="*70)
print("Ω-LP STRESS — HEADLINE NUMBERS")
print("="*70)

# Ground truth
gt = f"{RES}/ground-truth.json"
if os.path.exists(gt):
    s = json.load(open(gt))["summary"]
    print("\n## REAL Ω (ground truth)")
    print(f"  live clusters={s['totals']['clustersNonEmpty']:,}  total states={s['totals']['totalValidStates']:,}")
    print(f"  states/cluster: median={s['validStatesPerCluster']['p50']} p90={s['validStatesPerCluster']['p90']} "
          f"p99={s['validStatesPerCluster']['p99']} p99.9={s['validStatesPerCluster']['p999']} max={s['validStatesPerCluster']['max']}")
    print(f"  clusters dropped by 10k cap: {s['totals']['clustersDropped']}  enum-all={s['totals']['enumMsTotal']}ms")

# rows-free
rf = load("rows-free.csv")
if rf is not None:
    rf = rf[rf.status != "DROPPED"].copy()
    rf["total"] = rf.enumMs.fillna(0) + rf.buildLpMs.fillna(0) + rf.solveLpMs.fillna(0)
    print("\n## ROW SCALING (free, vars=2·log states)")
    solved = rf[rf.highsMs.notna()]
    print(f"  solved up to {int(solved.states.max()):,} states; walls past that")
    print(f"  max states, HiGHS solve  <1s : {fnum(cross(rf.states, rf.highsMs, 1000))}")
    print(f"  max states, solveLP      <1s : {fnum(cross(rf.states, rf.solveLpMs, 1000))}")
    print(f"  max states, full pipeline<1s : {fnum(cross(rf.states, rf.total, 1000))}")
    print(f"  max states, full pipeline<100ms: {fnum(cross(rf.states, rf.total, 100))}")
    for st in [1000, 10000, 100000]:
        row = rf.iloc[(rf.states-st).abs().argmin()]
        print(f"  @≈{int(row.states):>8,} states: enum={row.enumMs:.0f} buildLP={row.buildLpMs:.1f} str={row.strMs:.1f} highs={row.highsMs:.1f} solveLP={row.solveLpMs:.1f}ms  status={row.status}")
    # walls
    for st in ["SKIP_BUILD","SKIP_STR","SKIP_SOLVE","ABORT"]:
        w = rf[rf.status==st]
        if len(w): print(f"  WALL {st} first at {int(w.states.min()):,} states")

# rows-cat
rc = load("rows-cat.csv")
if rc is not None:
    rc["total"] = rc.enumMs.fillna(0)+rc.buildLpMs.fillna(0)+rc.solveLpMs.fillna(0)
    print("\n## ROW SCALING (categorical, vars=2·states — real regime)")
    for arb in ["none","fat"]:
        c = rc[rc.arb==arb]
        sv = c[c.highsMs.notna()]
        print(f"  arb={arb}: solved up to {int(sv.states.max()) if len(sv) else 0:,} states | "
              f"HiGHS<1s≤{fnum(cross(c.states,c.highsMs,1000))} | solveLP<1s≤{fnum(cross(c.states,c.solveLpMs,1000))}")
        for st in ["SKIP_SOLVE","SKIP_STR","SKIP_BUILD","ABORT"]:
            w = c[c.status==st]
            if len(w): print(f"      WALL {st} at k={int(w.k.min())} ({int(w.states.min())} states)")

# cols
cc = load("cols.csv")
if cc is not None:
    print("\n## COLUMN SCALING (fixed rows, vars↑ via decoy markets)")
    for fs in sorted(cc.fixedStates.unique()):
        d = cc[cc.fixedStates==fs]
        sv = d[d.highsMs.notna()]
        print(f"  {int(fs)} states: vars solved up to {int(sv.vars.max()) if len(sv) else 0} | HiGHS<1s≤{fnum(cross(d.vars,d.highsMs,1000))} vars")

# arb density
ad = load("arb-density.csv")
if ad is not None:
    print("\n## ARB DENSITY (does arb presence change solve speed?)")
    for k in sorted(ad.k.unique()):
        line = f"  k={k:>5}: "
        costs = {}
        for arb in ["none","thin","fat"]:
            v = ad[(ad.k==k)&(ad.arb==arb)]
            hv = v.highsMs.dropna()
            if len(hv):
                line += f"{arb}={hv.median():.1f}ms(cost{v.cost.median():.3f}) "
        print(line)
    # overall: median highs by arb (where all three present & solved)
    print("  -> per-k relative spread (max/min median highs across modes):")
    for k in sorted(ad.k.unique()):
        meds = []
        for arb in ["none","thin","fat"]:
            hv = ad[(ad.k==k)&(ad.arb==arb)].highsMs.dropna()
            if len(hv): meds.append(hv.median())
        if len(meds)>=2 and min(meds)>0:
            print(f"     k={k}: spread={max(meds)/min(meds):.2f}x")

# enum
en = load("enum.csv")
if en is not None:
    fr = en[en.archetype=="free"]
    print("\n## ENUMERATION (per graph-load)")
    print(f"  enum<1s ≤ {fnum(cross(fr.states, fr.enumMs, 1000))} states; "
          f"max measured {int(fr.states.max()):,} states = {fr.enumMs.max():.0f}ms / {fr.heapMB.max():.0f}MB heap")
    print(f"  memory/state ≈ {fr.heapMB.max()*1e6/fr.states.max():.0f} bytes/state (state Maps)")
print("\n"+"="*70)
