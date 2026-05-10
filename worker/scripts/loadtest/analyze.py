"""Analysis driver for game-day load-test runs.

Ingests the JSONL files produced by scripts/loadtest/driver.mjs (one
file per region, all under s3://<bucket>/runs/<run-tag>/<region>.jsonl
when run via Lambda) and produces the headline plots + numbers needed
to decide between architectures A, B, and D.

Why a script and not a notebook: a script is reproducible from a
checked-out commit and runs in CI; a notebook drifts in cell ordering
and stashes outputs that don't belong in git. The plot+CSV outputs
under output_dir/ are the deliverable. Open them in Jupyter or any
viewer if you want to slice further.

Usage:
    python analyze.py --run-dir ./results/<run-tag>/ \\
                       [--output-dir ./analysis/<run-tag>/]

Inputs:
    JSONL files in --run-dir, one per region. The driver emits:
      - one `run_start` line at the top
      - one `request` line per HTTP probe
      - one `request_error` line on failure
      - one `run_end` line at the bottom

Outputs (in --output-dir):
    - summary.csv             per-arch, per-region aggregate metrics
    - ttfb_by_arch.csv        full distribution rows for box plots
    - ttfb_box.png            box plot, TTFB by region × arch
    - cache_hit_rate.png      bar chart, hit rate by arch × region
    - origin_amplification.csv ratio of upstream calls / requests
    - tail_p99.csv            p99 TTFB by arch (the headline metric)
    - body_hash_convergence.csv per-cycle distinct-hash count by arch

The "headline" cells (the four numbers + one curve from the planning
doc) are flagged at end-of-run with a one-line summary. Use that as
the data-driven answer to "which architecture wins game day?".
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

REQUEST_TYPES = {"request", "request_error"}


def load_run(run_dir: Path) -> tuple[pd.DataFrame, dict]:
    """Read every *.jsonl file in run_dir; return (requests_df, metadata).

    `metadata` carries the `run_start` and `run_end` lines so downstream
    plots can axis-label by wallclock window.
    """
    rows = []
    starts: list[dict] = []
    ends: list[dict] = []
    files = sorted(run_dir.glob("*.jsonl"))
    if not files:
        raise SystemExit(f"no .jsonl files in {run_dir}")
    for path in files:
        with path.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    print(f"  skipping malformed line in {path.name}: {exc}", file=sys.stderr)
                    continue
                kind = obj.get("type")
                if kind == "run_start":
                    starts.append(obj)
                elif kind == "run_end":
                    ends.append(obj)
                elif kind in REQUEST_TYPES:
                    rows.append(obj)
    df = pd.DataFrame(rows)
    if df.empty:
        raise SystemExit("no request rows in run; nothing to analyze")
    # Coerce numeric columns. JSON nulls land as object dtype which
    # poisons subsequent .describe() calls.
    for col in ("ttfb_ms", "total_ms", "body_bytes", "cycle", "viewer_index", "status"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df["request_started_at"] = pd.to_datetime(df["request_started_at"], errors="coerce")
    return df, {"starts": starts, "ends": ends}


# ----- aggregations -----

def summary_table(df: pd.DataFrame) -> pd.DataFrame:
    """Per (arch, region) summary: count, p50/p95/p99 TTFB, hit rate."""
    ok = df[df["type"] == "request"].copy()
    if ok.empty:
        return pd.DataFrame()
    grp = ok.groupby(["target_label", "region"])
    agg = grp.agg(
        n=("ttfb_ms", "size"),
        p50_ttfb=("ttfb_ms", lambda s: s.quantile(0.50)),
        p95_ttfb=("ttfb_ms", lambda s: s.quantile(0.95)),
        p99_ttfb=("ttfb_ms", lambda s: s.quantile(0.99)),
        max_ttfb=("ttfb_ms", "max"),
        median_total=("total_ms", "median"),
        worker_hit_rate=("x_worker_cache", lambda s: (s == "HIT").mean()),
        cf_cache_hit_rate=("cf_cache_status", lambda s: (s == "HIT").mean()),
    )
    return agg.reset_index()


def origin_amplification(df: pd.DataFrame) -> pd.DataFrame:
    """Approximate origin Python call rate per architecture.

    Two modes, depending on whether the run was synthetic-replay or
    real-game:

      - Real game (no `?replay=` on the URL): `python;dur=...` in
        server-timing is the heavy-pipeline signature. Cache HITs
        skip that entirely. Use that as the upstream-call test.
      - Synthetic replay: `/cfb/process/replay` returns
        `replay_truncate;dur=0, total;dur=N` regardless of cache
        path, so `python;dur=` is never present. Fall back to the
        cache-hit heuristic: a request is "upstream" if neither
        `x-worker-cache: HIT` (Architecture A's per-PoP cache) nor
        `cf-cache-status: HIT` (CF edge cache, which Architecture B
        sees on the inner fetch though it doesn't surface in the
        Worker's response — see body_hash_convergence for the
        practical workaround).

    Strictly a ratio of "fresh upstream calls / total requests".
    Lower is better — every upstream call paid was a cache miss
    someone was about to also be paying for. With synthetic replay,
    interpret B's number cautiously: the Worker still re-renders HTML
    on a JSON cache HIT, so `worker_hit` will be 0 even when the
    expensive layer was cached.
    """
    ok = df[df["type"] == "request"].copy()
    ok["had_python_timing"] = ok["server_timing"].fillna("").str.contains(r"python;dur=", regex=True)
    ok["any_cache_hit"] = (
        (ok["x_worker_cache"] == "HIT")
        | (ok["cf_cache_status"] == "HIT")
        | (ok.get("x_upstream_cache", pd.Series(dtype=object)) == "HIT")
    )
    grp = ok.groupby("target_label")
    agg = grp.agg(
        requests=("had_python_timing", "size"),
        # Real-game signature: `python;dur=` was emitted.
        python_calls=("had_python_timing", "sum"),
        # Synthetic-replay signature: response was NOT a cache hit
        # at any layer (Worker `caches.default` for A; inner fetch+cf
        # for B; nothing for D). The `x-upstream-cache` header is the
        # B-specific signal — without it B's number would be wrong
        # because the Worker re-renders HTML every request and so
        # x-worker-cache never says HIT for arch=tiered.
        non_hit_calls=("any_cache_hit", lambda s: (~s).sum()),
    )
    agg["ratio_python"] = agg["python_calls"] / agg["requests"]
    agg["ratio_non_hit"] = agg["non_hit_calls"] / agg["requests"]
    return agg.reset_index()


def body_hash_convergence(df: pd.DataFrame, bucket_seconds: int = 30) -> pd.DataFrame:
    """For each arch and 30s wallclock bucket, count distinct body hashes.

    Coherent cache + matching SWR refresh = small distinct-hash count
    inside a bucket (most viewers see the same body version). High
    distinct-hash count = viewers seeing divergent bodies = SWR refresh
    is producing different content per request, which is the signal
    we want during synthetic-replay.
    """
    ok = df[(df["type"] == "request") & df["body_hash_short"].notna()].copy()
    if ok.empty:
        return pd.DataFrame()
    ok["bucket"] = (ok["request_started_at_offset_ms"] // (bucket_seconds * 1000)).astype("Int64")
    grp = ok.groupby(["target_label", "bucket"])
    agg = grp["body_hash_short"].nunique().reset_index(name="distinct_hashes")
    agg["wallclock_offset_s"] = agg["bucket"].astype("Int64") * bucket_seconds
    return agg


def tail_summary(df: pd.DataFrame) -> pd.DataFrame:
    """One-row-per-arch headline: n, p50, p95, p99, error rate."""
    grp = df.groupby("target_label")
    rows = []
    for label, sub in grp:
        ok = sub[sub["type"] == "request"]
        err = sub[sub["type"] == "request_error"]
        rows.append({
            "arch": label,
            "n_requests": len(ok),
            "n_errors": len(err),
            "p50_ttfb_ms": ok["ttfb_ms"].quantile(0.5) if not ok.empty else None,
            "p95_ttfb_ms": ok["ttfb_ms"].quantile(0.95) if not ok.empty else None,
            "p99_ttfb_ms": ok["ttfb_ms"].quantile(0.99) if not ok.empty else None,
            "error_rate": len(err) / max(len(ok) + len(err), 1),
        })
    return pd.DataFrame(rows)


# ----- plots -----

def plot_ttfb_box(df: pd.DataFrame, output_path: Path) -> None:
    """Per-arch TTFB box plot grouped by region. The headline figure."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ok = df[df["type"] == "request"].copy()
    archs = sorted(ok["target_label"].dropna().unique())
    regions = sorted(ok["region"].dropna().unique())

    fig, axes = plt.subplots(1, len(archs), figsize=(5 * len(archs), 5), sharey=True)
    if len(archs) == 1:
        axes = [axes]
    for ax, arch in zip(axes, archs):
        sub = ok[ok["target_label"] == arch]
        data = [sub.loc[sub["region"] == r, "ttfb_ms"].dropna().tolist() for r in regions]
        ax.boxplot(data, tick_labels=regions, showfliers=False)
        ax.set_title(f"Architecture {arch}")
        ax.set_xlabel("region")
        ax.set_yscale("log")
        # x-axis label rotation so 6 region labels fit.
        for tick in ax.get_xticklabels():
            tick.set_rotation(45)
            tick.set_ha("right")
    axes[0].set_ylabel("TTFB ms (log scale)")
    fig.suptitle("TTFB by region × architecture (boxes hide outliers)")
    fig.tight_layout()
    fig.savefig(output_path, dpi=110)
    plt.close(fig)


def plot_cache_hit_rate(df: pd.DataFrame, output_path: Path) -> None:
    """Per-arch, per-region grouped bars: x_worker_cache HIT rate +
    cf_cache_status HIT rate stacked side-by-side. Lets you see at a
    glance whether the warm path is working in each PoP."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    ok = df[df["type"] == "request"].copy()
    summary = summary_table(ok)
    if summary.empty:
        return
    archs = sorted(summary["target_label"].unique())
    regions = sorted(summary["region"].unique())

    fig, ax = plt.subplots(figsize=(max(8, len(regions) * 1.5), 5))
    x = np.arange(len(regions))
    width = 0.8 / max(len(archs), 1)
    for i, arch in enumerate(archs):
        sub = summary[summary["target_label"] == arch].set_index("region").reindex(regions)
        ax.bar(x + (i - (len(archs) - 1) / 2) * width, sub["worker_hit_rate"].fillna(0), width, label=f"{arch} worker")
    ax.set_xticks(x)
    ax.set_xticklabels(regions, rotation=45, ha="right")
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("x-worker-cache HIT rate")
    ax.set_title("Cache HIT rate by region × architecture")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_path, dpi=110)
    plt.close(fig)


# ----- entry point -----

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True, type=Path)
    p.add_argument("--output-dir", type=Path, default=None)
    args = p.parse_args()

    output_dir = args.output_dir or (args.run_dir / "analysis")
    output_dir.mkdir(parents=True, exist_ok=True)

    df, meta = load_run(args.run_dir)

    # Persisted CSV outputs first — these are the durable artifacts.
    summary_table(df).to_csv(output_dir / "summary.csv", index=False)
    origin_amplification(df).to_csv(output_dir / "origin_amplification.csv", index=False)
    body_hash_convergence(df).to_csv(output_dir / "body_hash_convergence.csv", index=False)
    tail = tail_summary(df)
    tail.to_csv(output_dir / "tail_p99.csv", index=False)
    df.to_csv(output_dir / "all_requests.csv", index=False)

    # Plots second.
    plot_ttfb_box(df, output_dir / "ttfb_box.png")
    plot_cache_hit_rate(df, output_dir / "cache_hit_rate.png")

    print(f"Wrote analysis to {output_dir}")
    print()
    print("Headline TTFB by architecture:")
    print(tail.to_string(index=False))
    print()
    print("Origin amplification (lower = better):")
    print(origin_amplification(df).to_string(index=False))


if __name__ == "__main__":
    main()
