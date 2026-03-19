#!/usr/bin/env python3
"""
Preprocess connectome parquet to a subset: all neurons within N degrees of EPG
(upstream + downstream) and optionally all downstream from PEN_a.

  --epg-only: only keep N-degree neighborhood of EPG (no PEN_a downstream).
              Use this for maximum compression; PEN_a are usually inside this neighborhood.
  Default: EPG N-degree ∪ (PEN_a + all downstream). Note: downstream-from-PEN_a
  often reaches almost the whole brain, so compression can be minimal.

Requires: pyarrow  (pip install pyarrow, or use .venv-subset: .venv-subset/bin/python this script)
Usage:
  python scripts/subset_connectome_epg_pen.py [--degrees N] [--epg-only] [--out path]
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

try:
    import pyarrow.parquet as pq
    import pyarrow as pa
    import pyarrow.compute as pc
except ImportError:
    print("This script requires pyarrow. Install with: pip install pyarrow", file=sys.stderr)
    sys.exit(1)

# Repo layout: script in neurosim/scripts/, data in neurosim/data/raw/
ROOT = Path(__file__).resolve().parent.parent
CLASSIFICATION_CSV = ROOT / "data" / "raw" / "classification.csv"
PARQUET_IN = ROOT / "data" / "raw" / "2025_Connectivity_783.parquet"
DEFAULT_PARQUET_OUT = ROOT / "data" / "raw" / "2025_Connectivity_783_epg_pen_subset.parquet"


def load_epg_and_pen_a(classification_path: Path) -> tuple[set[str], set[str]]:
    """Load EPG and PEN_a root_id sets from classification.csv (same logic as brain-service)."""
    epg: set[str] = set()
    pen_a: set[str] = set()
    with open(classification_path, newline="", encoding="utf-8") as f:
        rdr = csv.DictReader(f)
        if not rdr.fieldnames:
            return epg, pen_a
        for row in rdr:
            root_id = (row.get("root_id") or "").strip()
            hemibrain = (row.get("hemibrain_type") or "").strip()
            if not root_id:
                continue
            if hemibrain.startswith("PEN_a"):
                pen_a.add(root_id)
            elif "EPG" in hemibrain and hemibrain != "EPGt":
                epg.add(root_id)
    return epg, pen_a


def build_adjacency(table: pa.Table, pre_col: str, post_col: str):
    """Build pre->[posts] and post->[pres] from parquet table."""
    pre_values = (
        pc.cast(table.column(pre_col), pa.string())
        .combine_chunks()
        .to_pylist()
    )
    post_values = (
        pc.cast(table.column(post_col), pa.string())
        .combine_chunks()
        .to_pylist()
    )
    pre_to_posts: dict[str, list[str]] = {}
    post_to_pres: dict[str, list[str]] = {}
    for pre, post in zip(pre_values, post_values, strict=True):
        if pre is None or post is None:
            continue
        pre_s = str(pre)
        post_s = str(post)
        pre_to_posts.setdefault(pre_s, []).append(post_s)
        post_to_pres.setdefault(post_s, []).append(pre_s)
    return pre_to_posts, post_to_pres


def expand_n_degrees_from_epg(
    epg: set[str],
    pre_to_posts: dict[str, list[str]],
    post_to_pres: dict[str, list[str]],
    n_degrees: int,
) -> set[str]:
    """All neurons within n hops of EPG (both upstream and downstream)."""
    current: set[str] = set(epg)
    frontier: set[str] = set(epg)
    for _ in range(n_degrees):
        if not frontier:
            break
        next_frontier: set[str] = set()
        for n in frontier:
            for post in pre_to_posts.get(n, []):
                if post not in current:
                    current.add(post)
                    next_frontier.add(post)
            for pre in post_to_pres.get(n, []):
                if pre not in current:
                    current.add(pre)
                    next_frontier.add(pre)
        frontier = next_frontier
    return current


def all_downstream_from(seeds: set[str], pre_to_posts: dict[str, list[str]]) -> set[str]:
    """All neurons reachable by following postsynaptic (pre->post) edges from seeds."""
    result: set[str] = set(seeds)
    frontier: set[str] = set(seeds)
    while frontier:
        new_frontier: set[str] = set()
        for n in frontier:
            for post in pre_to_posts.get(n, []):
                if post not in result:
                    result.add(post)
                    new_frontier.add(post)
        frontier = new_frontier
    return result


def pick_column(names: list[str], candidates: list[str]) -> str | None:
    for c in candidates:
        for n in names:
            if n == c or n.strip().lower() == c.strip().lower():
                return n
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Subset connectome to EPG + N-degree + PEN_a downstream")
    ap.add_argument("--degrees", type=int, default=2, help="Degrees of expansion around EPG (default 2)")
    ap.add_argument("--epg-only", action="store_true", help="Only EPG N-degree neighborhood (no PEN_a downstream); better compression")
    ap.add_argument("--out", type=Path, default=None, help="Output parquet path (default depends on --epg-only)")
    ap.add_argument("--in", dest="input_path", type=Path, default=PARQUET_IN, help="Input parquet path")
    args = ap.parse_args()
    if args.out is None:
        args.out = ROOT / "data" / "raw" / ("2025_Connectivity_783_epg_pen_subset.parquet" if not args.epg_only else "2025_Connectivity_783_epg_only_subset.parquet")

    if not CLASSIFICATION_CSV.exists():
        print(f"Classification not found: {CLASSIFICATION_CSV}", file=sys.stderr)
        sys.exit(1)
    if not args.input_path.exists():
        print(f"Connectome not found: {args.input_path}", file=sys.stderr)
        sys.exit(1)

    print("Loading EPG and PEN_a from classification...")
    epg, pen_a = load_epg_and_pen_a(CLASSIFICATION_CSV)
    print(f"  EPG: {len(epg)}  PEN_a: {len(pen_a)}")

    print("Reading parquet...")
    table = pq.read_table(args.input_path)
    names = table.column_names
    pre_col = pick_column(names, ["Presynaptic_ID", "pre_root_id", "pre", "source", "from"])
    post_col = pick_column(names, ["Postsynaptic_ID", "post_root_id", "post", "target", "to"])
    weight_candidates = ["Excitatory x Connectivity", "weight", "syn_count", "Connectivity"]
    weight_col = pick_column(names, weight_candidates)

    if not pre_col or not post_col:
        print("Parquet must have pre and post columns (e.g. Presynaptic_ID, Postsynaptic_ID)", file=sys.stderr)
        sys.exit(1)

    total_rows = table.num_rows
    print(f"  Rows: {total_rows:,}  Columns: pre={pre_col} post={post_col} weight={weight_col}")
    if total_rows == 0:
        print("  Input parquet has no rows; writing empty output and exiting.")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, args.out)
        print(f"Wrote {args.out}")
        print("Compression: 0 -> 0 edges (0.0% reduction)")
        return

    print("Building adjacency...")
    pre_to_posts, post_to_pres = build_adjacency(table, pre_col, post_col)
    all_neurons = set(pre_to_posts.keys()) | set(post_to_pres.keys())
    print(f"  Neurons in connectome: {len(all_neurons):,}")

    # Subgraph: (N degrees from EPG) and optionally ∪ (PEN_a + all downstream from PEN_a)
    print(f"Expanding {args.degrees} degrees from EPG...")
    s_epg = expand_n_degrees_from_epg(epg, pre_to_posts, post_to_pres, args.degrees)
    print(f"  EPG + {args.degrees}-hop neighborhood: {len(s_epg):,} neurons")

    if args.epg_only:
        keep = s_epg
        print("  (--epg-only: not adding PEN_a downstream)")
    else:
        print("Computing all downstream from PEN_a...")
        s_pen = all_downstream_from(pen_a, pre_to_posts)
        print(f"  PEN_a + downstream: {len(s_pen):,} neurons")
        keep = s_epg | s_pen
    print(f"  Subgraph total: {len(keep):,} neurons")

    # Filter rows: keep only edges where both endpoints are in keep (vectorized Arrow ops)
    print("Filtering edges...")
    keep_arr = pa.array(sorted(keep), type=pa.string())
    pre_col_arr = pc.cast(table.column(pre_col), pa.string())
    post_col_arr = pc.cast(table.column(post_col), pa.string())
    pre_in_keep = pc.is_in(pre_col_arr, value_set=keep_arr)
    post_in_keep = pc.is_in(post_col_arr, value_set=keep_arr)
    mask = pc.and_(pre_in_keep, post_in_keep)
    n_keep = int(pc.sum(pc.cast(mask, pa.int64())).as_py() or 0)
    print(f"  Edges kept: {n_keep:,} / {total_rows:,} ({100.0 * n_keep / total_rows:.2f}%)")

    # Build filtered table (same schema)
    filtered = table.filter(mask)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(filtered, args.out)
    print(f"Wrote {args.out}")
    print(f"Compression: {total_rows:,} -> {n_keep:,} edges ({100.0 * (1 - n_keep / total_rows):.1f}% reduction)")


if __name__ == "__main__":
    main()
