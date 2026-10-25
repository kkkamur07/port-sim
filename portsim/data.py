"""Fetch the PortSimEnv parquet files and build the SFT set the recipe asks for.

    python -m portsim.data fetch
    python -m portsim.data build --recipe portsim/recipe.json --out data/sft.jsonl
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import pandas as pd
from huggingface_hub import hf_hub_download

from portsim import ROOT

REPO = "FineEnvs/PortSimEnv"
RAW = ROOT / "data" / "raw"
FILES = {"train": "tasks/train.parquet", "eval": "tasks/eval.parquet", "rollouts": "rollouts/eval.parquet"}


def fetch() -> dict[str, Path]:
    RAW.mkdir(parents=True, exist_ok=True)
    out = {}
    for key, path in FILES.items():
        p = hf_hub_download(REPO, path, repo_type="dataset", local_dir=RAW)
        out[key] = Path(p)
    return out


def load(split: str) -> pd.DataFrame:
    p = RAW / FILES[split]
    if not p.exists():
        fetch()
    return pd.read_parquet(p)


def messages_for(row, suffix: str) -> list[dict]:
    return [{"role": "system", "content": row["system_prompt"]},
            {"role": "user", "content": row["situation"] + suffix}]


def compact_plan(plan_json: str) -> str:
    rows = json.loads(plan_json)
    return json.dumps(rows, separators=(",", ":"))


def build(recipe: dict, out: Path, seed: int = 0) -> dict:
    cfg = recipe["data"]
    df = load("train")
    df = df[df["difficulty"].isin(cfg["include_difficulties"]) & (df["num_ships"] <= cfg["max_ships"])]
    rng = random.Random(seed)
    examples = []
    for _, r in df.iterrows():
        target = compact_plan(r[cfg["target"]])
        n = int(cfg["repeat_by_difficulty"].get(r["difficulty"], 1))
        for _ in range(n):
            examples.append({"task_id": r["task_id"], "difficulty": r["difficulty"], "num_ships": int(r["num_ships"]),
                             "messages": messages_for(r, cfg["user_suffix"]) + [{"role": "assistant", "content": target}]})
    # Extra examples Argon adds (e.g. repaired plans with reasoning), already in messages form
    for ex in cfg.get("extra_examples", []):
        examples.append(ex)
    rng.shuffle(examples)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    chars = sum(len(m["content"]) for ex in examples for m in ex["messages"])
    stats = {"examples": len(examples), "tasks": int(df["task_id"].nunique()), "approx_tokens": chars // 4,
             "by_difficulty": {k: int(v) for k, v in pd.Series([e["difficulty"] for e in examples]).value_counts().items()}}
    (out.with_suffix(".stats.json")).write_text(json.dumps(stats, indent=1))
    return stats


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    b = sub.add_parser("build")
    b.add_argument("--recipe", default=str(ROOT / "portsim" / "recipe.json"))
    b.add_argument("--out", default=str(ROOT / "data" / "sft.jsonl"))
    a = ap.parse_args()
    if a.cmd == "fetch":
        print(json.dumps({k: str(v) for k, v in fetch().items()}, indent=1))
    else:
        print(json.dumps(build(json.loads(Path(a.recipe).read_text()), Path(a.out)), indent=1))


if __name__ == "__main__":
    main()
