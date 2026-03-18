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
    pre_arr = table.column(pre_col)
    post_arr = table.column(post_col)
    pre_to_posts: dict[str, list[str]] = {}
    post_to_pres: dict[str, list[str]] = {}
    for i in range(table.num_rows):
        pre = str(pre_arr[i]) if pre_arr[i] is not None else None
        post = str(post_arr[i]) if post_arr[i] is not None else None
        if pre is None or post is None:
            continue
        pre_to_posts.setdefault(pre, []).append(post)
        post_to_pres.setdefault(post, []).append(pre)
    return pre_to_posts, post_to_pres


def expand_n_degrees_from_epg(
    epg: set[str],
    pre_to_posts: dict[str, list[str]],
    post_to_pres: dict[str, list[str]],
    n_degrees: int,
) -> set[str]:
    """All neurons within n hops of EPG (both upstream and downstream)."""
    current: set[str] = set(epg)
    for _ in range(n_degrees):
        next_set: set[str] = set(current)
        for n in current:
            for post in pre_to_posts.get(n, []):
                next_set.add(post)
            for pre in post_to_pres.get(n, []):
                next_set.add(pre)
        current = next_set
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

    # Filter rows: keep only edges where both endpoints are in keep
    print("Filtering edges...")
    pre_arr = table.column(pre_col)
    post_arr = table.column(post_col)
    mask = []
    for i in range(table.num_rows):
        pre = str(pre_arr[i]) if pre_arr[i] is not None else ""
        post = str(post_arr[i]) if post_arr[i] is not None else ""
        mask.append(pre in keep and post in keep)

    n_keep = sum(mask)
    print(f"  Edges kept: {n_keep:,} / {total_rows:,} ({100.0 * n_keep / total_rows:.2f}%)")

    # Build filtered table (same schema)
    indices = [i for i, b in enumerate(mask) if b]
    filtered = table.take(pa.array(indices))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(filtered, args.out)
    print(f"Wrote {args.out}")
    print(f"Compression: {total_rows:,} -> {n_keep:,} edges ({100.0 * (1 - n_keep / total_rows):.1f}% reduction)")


if __name__ == "__main__":
    main()
