#!/usr/bin/env python3
"""
Ω-LP stress-test figure generator. Reads the ground-truth JSON + harness CSVs in
data/omega-stress/results/ and emits publication-quality PNGs into
data/omega-stress/figures/, plus a derived `headline.json` with the
max-states-under-budget table used by the audit paper.

Run:  python data/omega-stress/plots.py
"""
import json, os, math
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import LogLocator, FuncFormatter

RES = "data/omega-stress/results"
FIG = "data/omega-stress/figures"
os.makedirs(FIG, exist_ok=True)

plt.rcParams.update({
    "figure.dpi": 130, "savefig.dpi": 130, "font.size": 11,
    "axes.grid": True, "grid.alpha": 0.3, "axes.axisbelow": True,
    "figure.facecolor": "white", "axes.facecolor": "#fbfbfd",
})
C = {"enum": "#7b68ee", "buildLp": "#20b2aa", "str": "#ff8c42",
     "highs": "#e63946", "solveLp": "#1d3557", "total": "#111111",
     "none": "#2a9d8f", "thin": "#e9c46a", "fat": "#e76f51"}

ONE_SEC = 1000.0
PROD_CAP = 10000
REAL_MAX = 804  # biggest realized Ω in the live DB (ground truth)


def load_csv(name):
    p = f"{RES}/{name}"
    if not os.path.exists(p):
        print(f"  (skip {name} — not found)")
        return None
    try:
        df = pd.read_csv(p)
        return df if len(df) else None
    except Exception as e:
        print(f"  (skip {name} — {e})")
        return None


def fmt_int(x, _=None):
    if x >= 1e6: return f"{x/1e6:.0f}M"
    if x >= 1e3: return f"{x/1e3:.0f}k"
    return f"{x:.0f}"


def annotate_refs(ax, ymax_frac=0.95, show_cap=True):
    ax.axhline(ONE_SEC, color="crimson", ls="--", lw=1.2, alpha=0.8)
    ax.text(ax.get_xlim()[0], ONE_SEC * 1.15, " 1 second budget",
            color="crimson", fontsize=9, va="bottom")
    if show_cap:
        ax.axvline(PROD_CAP, color="#555", ls=":", lw=1.2)
        ax.text(PROD_CAP, ax.get_ylim()[0], " prod cap 10k", rotation=90,
                color="#555", fontsize=8, va="bottom", ha="right")
        ax.axvline(REAL_MAX, color="#0a7", ls=":", lw=1.2)
        ax.text(REAL_MAX, ax.get_ylim()[0], " real max 804", rotation=90,
                color="#0a7", fontsize=8, va="bottom", ha="right")


def crossing(x, y, thresh):
    """Largest x with y<thresh, log-interpolated to the threshold crossing."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    below = y < thresh
    if below.all(): return x.max(), "all-below"
    if not below.any(): return None, "all-above"
    # last index that is below before first crossing
    idx = np.where((y[:-1] < thresh) & (y[1:] >= thresh))[0]
    if len(idx) == 0:
        return (x[below].max(), "noninterp")
    i = idx[0]
    lx0, lx1 = math.log(x[i]), math.log(x[i+1])
    ly0, ly1 = math.log(max(y[i], 1e-6)), math.log(max(y[i+1], 1e-6))
    lt = math.log(thresh)
    fx = lx0 + (lt - ly0) * (lx1 - lx0) / (ly1 - ly0)
    return math.exp(fx), "interp"


# ─────────────────────────── Fig 1: real Ω distribution ───────────────────────
def fig_real():
    p = f"{RES}/ground-truth.json"
    if not os.path.exists(p):
        print("  (skip fig1 — no ground-truth.json)"); return
    gt = json.load(open(p))
    stats = pd.DataFrame(gt["stats"])
    s = gt["summary"]
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.4))

    ne = stats[stats.validStates > 0]
    bins = np.logspace(0, math.log10(max(ne.validStates.max(), 2)) + 0.05, 40)
    ax[0].hist(ne.validStates, bins=bins, color="#4361ee", alpha=0.85, edgecolor="white", lw=0.3)
    ax[0].set_xscale("log"); ax[0].set_yscale("log")
    ax[0].axvline(REAL_MAX, color="#0a7", ls="--", lw=1.3, label=f"max realized = {int(ne.validStates.max())}")
    ax[0].axvline(PROD_CAP, color="#555", ls=":", lw=1.3, label="prod cap 10,000")
    v = s["validStatesPerCluster"]
    ax[0].axvline(v["p50"], color="#e63946", ls="-.", lw=1.1, label=f"median = {v['p50']}")
    ax[0].set_xlabel("valid world-states per cluster (LP constraint rows)")
    ax[0].set_ylabel("number of clusters")
    ax[0].set_title(f"(a) Real Ω size distribution\n{s['totals']['clustersNonEmpty']:,} live clusters, "
                    f"{s['totals']['totalValidStates']:,} total states")
    ax[0].legend(fontsize=8.5)

    # markets vs states scatter
    ax[1].scatter(ne.markets, ne.validStates, s=10, alpha=0.35, color="#7209b7", edgecolors="none")
    ax[1].set_xscale("log"); ax[1].set_yscale("log")
    ax[1].set_xlabel("markets per cluster (vars = 2×)")
    ax[1].set_ylabel("valid world-states")
    ax[1].set_title("(b) Ω size vs market count\n(each point = one live cluster)")
    for q, lbl in [(v["p90"], "p90"), (v["p99"], "p99")]:
        ax[1].axhline(q, color="#888", ls=":", lw=0.8)
        ax[1].text(ne.markets.min(), q, f" {lbl}={q}", fontsize=8, color="#555", va="bottom")
    fig.tight_layout(); fig.savefig(f"{FIG}/fig1_real_distribution.png"); plt.close(fig)
    print("  fig1_real_distribution.png")


# ─────────────────── Fig 2: row scaling (free archetype, phases) ──────────────
def fig_rows_free():
    df = load_csv("rows-free.csv")
    if df is None: return
    df = df[df.status != "DROPPED"].copy()
    df = df[df.states > 0].sort_values("states")
    fig, ax = plt.subplots(figsize=(10, 6))
    for key, lbl in [("enumMs", "enumerate states"), ("buildLpMs", "build LP matrix"),
                     ("strMs", "serialize LP string"), ("highsMs", "HiGHS solve"),
                     ("solveLpMs", "solveLP (str+solve+extract)")]:
        if key in df: ax.plot(df.states, df[key], "o-", color=C[key.replace("Ms", "")], label=lbl, lw=1.8, ms=5)
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("valid world-states  (free archetype, vars = 2·log₂(states))")
    ax.set_ylabel("time (ms, median)")
    ax.set_title("Fig 2 — Per-phase time vs Ω size (ROW scaling, minimal vars)")
    annotate_refs(ax)
    # crossing of total pipeline & solve
    tot = df.enumMs.fillna(0) + df.buildLpMs.fillna(0) + df.solveLpMs.fillna(0)
    xc, _ = crossing(df.states.values, tot.values, ONE_SEC)
    xs, _ = crossing(df.states.values, df.solveLpMs.values, ONE_SEC)
    txt = []
    if xc: txt.append(f"pipeline<1s ≤ {fmt_int(xc)} states")
    if xs: txt.append(f"solveLP<1s ≤ {fmt_int(xs)} states")
    ax.legend(fontsize=9, loc="upper left")
    if txt: ax.text(0.98, 0.03, "\n".join(txt), transform=ax.transAxes, fontsize=9,
                    ha="right", va="bottom", bbox=dict(boxstyle="round", fc="#fff8e1", ec="#e6a700"))
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig2_rows_free.png"); plt.close(fig)
    print("  fig2_rows_free.png")


# ─────────────────── Fig 3: phase fraction (where time goes) ──────────────────
def fig_phase_fraction():
    df = load_csv("rows-free.csv")
    if df is None: return
    df = df[(df.status != "DROPPED") & (df.states > 0)].sort_values("states").copy()
    comp = df[["enumMs", "buildLpMs", "strMs", "highsMs"]].fillna(0).values
    frac = comp / comp.sum(axis=1, keepdims=True)
    fig, ax = plt.subplots(figsize=(10, 5.5))
    labels = ["enumerate", "build LP matrix", "serialize string", "HiGHS solve"]
    cols = [C["enum"], C["buildLp"], C["str"], C["highs"]]
    ax.stackplot(df.states, frac.T * 100, labels=labels, colors=cols, alpha=0.88)
    ax.set_xscale("log"); ax.set_xlim(df.states.min(), df.states.max())
    ax.set_ylim(0, 100)
    ax.set_xlabel("valid world-states (free archetype)")
    ax.set_ylabel("share of wall time (%)")
    ax.set_title("Fig 3 — Where the time goes: phase share vs Ω size")
    ax.legend(loc="center left", fontsize=9, framealpha=0.9)
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig3_phase_fraction.png"); plt.close(fig)
    print("  fig3_phase_fraction.png")


# ─────────────────── Fig 4: categorical vs free (vars effect) ─────────────────
def fig_cat_vs_free():
    cat = load_csv("rows-cat.csv"); free = load_csv("rows-free.csv")
    if cat is None and free is None: return
    fig, ax = plt.subplots(figsize=(10, 6))
    if free is not None:
        f = free[(free.status != "DROPPED") & (free.states > 0)].sort_values("states")
        ax.plot(f.states, f.solveLpMs, "s-", color="#1d3557", lw=1.8, ms=5,
                label="free  (vars=2·log₂ states — minimal cols)")
    if cat is not None:
        for arb, mk, cc in [("none", "o-", "#2a9d8f"), ("fat", "^-", "#e76f51")]:
            c = cat[(cat.arb == arb) & (cat.states > 0)].sort_values("states")
            if len(c):
                ax.plot(c.states, c.solveLpMs, mk, color=cc, lw=1.8, ms=5,
                        label=f"categorical {arb} (vars=2·states — coupled)")
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("valid world-states")
    ax.set_ylabel("solveLP time (ms, median)")
    ax.set_title("Fig 4 — Same rows, different cols: free vs categorical Ω")
    annotate_refs(ax)
    ax.legend(fontsize=9, loc="upper left")
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig4_cat_vs_free.png"); plt.close(fig)
    print("  fig4_cat_vs_free.png")


# ─────────────────── Fig 5: column scaling at fixed rows ──────────────────────
def fig_cols():
    df = load_csv("cols.csv")
    if df is None: return
    fig, ax = plt.subplots(figsize=(10, 6))
    for fs, cc in zip(sorted(df.fixedStates.unique()), ["#4895ef", "#3f37c9", "#b5179e"]):
        d = df[df.fixedStates == fs].sort_values("vars")
        ax.plot(d.vars, d.solveLpMs, "o-", color=cc, lw=1.8, ms=5, label=f"{int(fs)} states (rows fixed)")
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set_xlabel("LP variables (cols = 2·markets)")
    ax.set_ylabel("solveLP time (ms, median)")
    ax.set_title("Fig 5 — Column scaling at fixed Ω size (decoy markets inflate cols)")
    ax.axhline(ONE_SEC, color="crimson", ls="--", lw=1.2, alpha=0.8)
    ax.text(df.vars.min(), ONE_SEC * 1.15, " 1 second", color="crimson", fontsize=9)
    ax.legend(fontsize=9)
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig5_cols.png"); plt.close(fig)
    print("  fig5_cols.png")


# ─────────────────── Fig 6: arb density effect on solve time ──────────────────
def fig_arb_density():
    df = load_csv("arb-density.csv")
    if df is None: return
    ks = sorted(df.k.unique())
    fig, ax = plt.subplots(figsize=(11, 6))
    width = 0.25
    modes = ["none", "thin", "fat"]
    x = np.arange(len(ks))
    for j, mode in enumerate(modes):
        meds, lo, hi = [], [], []
        for k in ks:
            v = df[(df.k == k) & (df.arb == mode)].highsMs.values
            if len(v):
                meds.append(np.median(v)); lo.append(np.percentile(v, 10)); hi.append(np.percentile(v, 90))
            else:
                meds.append(np.nan); lo.append(np.nan); hi.append(np.nan)
        meds = np.array(meds)
        err = np.vstack([meds - np.array(lo), np.array(hi) - meds])
        ax.bar(x + (j - 1) * width, meds, width, yerr=err, capsize=3,
               color=C[mode], label=f"{mode} arb", alpha=0.9)
    ax.set_yscale("log")
    ax.set_xticks(x); ax.set_xticklabels([f"{k}\n({k} st)" for k in ks])
    ax.set_xlabel("categorical slot count k  (states = k, vars = 2k)")
    ax.set_ylabel("HiGHS solve time (ms, median ± p10–p90)")
    ax.set_title("Fig 6 — Does arb presence change solve speed?  (none vs thin vs fat)")
    ax.legend(fontsize=9)
    fig.tight_layout(); fig.savefig(f"{FIG}/fig6_arb_density.png"); plt.close(fig)
    print("  fig6_arb_density.png")


# ─────────────────── Fig 7: memory wall + enumeration cost ────────────────────
def fig_memory():
    en = load_csv("enum.csv"); rf = load_csv("rows-free.csv")
    if en is None and rf is None: return
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.6))
    if en is not None:
        fr = en[en.archetype == "free"].sort_values("states")
        ax[0].plot(fr.states, fr.enumMs, "o-", color=C["enum"], lw=1.8, ms=5, label="free 2^f")
        cart = en[en.archetype.str.startswith("cartesian")]
        if len(cart):
            ax[0].scatter(cart.states, cart.enumMs, color="#e63946", s=40, zorder=5, label="cartesian (k+1)^s")
        ax[0].set_xscale("log"); ax[0].set_yscale("log")
        ax[0].set_xlabel("valid world-states"); ax[0].set_ylabel("enumerateStates time (ms)")
        ax[0].set_title("(a) Enumeration cost (per graph-load)")
        ax[0].axhline(ONE_SEC, color="crimson", ls="--", lw=1.1, alpha=0.7)
        ax[0].legend(fontsize=9)
        ax[0].xaxis.set_major_formatter(FuncFormatter(fmt_int))
    if rf is not None and "rssMB" in rf:
        d = rf[(rf.status != "DROPPED") & (rf.states > 0)].sort_values("states")
        ax[1].plot(d.states, d.rssMB, "o-", color="#6a4c93", lw=1.8, ms=5, label="RSS")
        if "heapMB" in d: ax[1].plot(d.states, d.heapMB, "s--", color="#1982c4", lw=1.5, ms=4, label="V8 heap")
        ax[1].set_xscale("log"); ax[1].set_yscale("log")
        ax[1].set_xlabel("valid world-states (free archetype)"); ax[1].set_ylabel("process memory (MB)")
        ax[1].set_title("(b) Memory footprint vs Ω size")
        ax[1].legend(fontsize=9)
        ax[1].xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig7_memory.png"); plt.close(fig)
    print("  fig7_memory.png")


# ─────────────────── Fig 8 + headline.json: max states under budget ───────────
def fig_headline():
    free = load_csv("rows-free.csv"); cat = load_csv("rows-cat.csv")
    budgets = [1, 10, 100, 1000]
    table = {}
    fig, ax = plt.subplots(figsize=(10, 6))
    series = []
    if free is not None:
        f = free[(free.status != "DROPPED") & (free.states > 0)].sort_values("states")
        tot = (f.enumMs.fillna(0) + f.buildLpMs.fillna(0) + f.solveLpMs.fillna(0)).values
        series.append(("free pipeline", f.states.values, tot, "#1d3557"))
        series.append(("free HiGHS solve", f.states.values, f.highsMs.values, "#e63946"))
    if cat is not None:
        c = cat[(cat.arb == "none") & (cat.states > 0)].sort_values("states")
        if len(c):
            tot = (c.enumMs.fillna(0) + c.buildLpMs.fillna(0) + c.solveLpMs.fillna(0)).values
            series.append(("categorical pipeline", c.states.values, tot, "#2a9d8f"))
    for name, xs, ys, _ in series:
        row = {}
        for b in budgets:
            xc, how = crossing(xs, ys, b)
            row[f"{b}ms"] = None if xc is None else int(xc)
        table[name] = row
    # bar chart of max states under 1s
    names = [s[0] for s in series]
    vals = [table[n].get("1000ms") or 0 for n in names]
    cols = [s[3] for s in series]
    ax.barh(names, vals, color=cols, alpha=0.9)
    for i, v in enumerate(vals):
        ax.text(v, i, f" {fmt_int(v)}", va="center", fontsize=10, fontweight="bold")
    ax.set_xscale("log")
    ax.set_xlabel("max valid world-states solvable in < 1 second")
    ax.set_title("Fig 8 — Headline: max Ω size under a 1-second budget, by regime")
    ax.axvline(REAL_MAX, color="#0a7", ls=":", lw=1.5); ax.text(REAL_MAX, -0.4, "real max 804", color="#0a7", fontsize=8, rotation=90, va="bottom")
    ax.axvline(PROD_CAP, color="#555", ls=":", lw=1.5); ax.text(PROD_CAP, -0.4, "prod cap 10k", color="#555", fontsize=8, rotation=90, va="bottom")
    ax.xaxis.set_major_formatter(FuncFormatter(fmt_int))
    fig.tight_layout(); fig.savefig(f"{FIG}/fig8_headline.png"); plt.close(fig)
    json.dump(table, open(f"{RES}/headline.json", "w"), indent=2)
    print("  fig8_headline.png + headline.json")
    print("  MAX-STATES-UNDER-BUDGET:", json.dumps(table, indent=2))


if __name__ == "__main__":
    print("Generating figures...")
    for fn in [fig_real, fig_rows_free, fig_phase_fraction, fig_cat_vs_free,
               fig_cols, fig_arb_density, fig_memory, fig_headline]:
        try: fn()
        except Exception as e:
            import traceback; print(f"  ERR {fn.__name__}: {e}"); traceback.print_exc()
    print("done.")
