"""Run the 50 eval tasks (or any split) against an OpenAI-compatible endpoint and grade every answer.

    python -m portsim.evaluate --run loop1 --base-url http://gpu:8000/v1 --model qwen-sft
    python -m portsim.evaluate --run argon0 --base-url https://generativelanguage.googleapis.com/v1beta/openai/ \
        --model gemini-4-argon --api-key $GEMINI_API_KEY

Writes runs/<run>/rollouts.jsonl (one line per task: prompt, answer, grade) and runs/<run>/summary.json.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from openai import AsyncOpenAI

from portsim import ROOT
from portsim.data import load, messages_for
from portsim.grade import grade_text, load_task

RUNS = ROOT / "runs"


async def ask(client, model, messages, cfg, sem, thinking: bool):
    extra = {} if thinking else {"chat_template_kwargs": {"enable_thinking": False}}
    async with sem:
        t0 = time.time()
        try:
            r = await client.chat.completions.create(
                model=model, messages=messages, temperature=cfg["temperature"], max_tokens=cfg["max_tokens"],
                extra_body=extra)
            text = r.choices[0].message.content or ""
            usage = r.usage.model_dump() if r.usage else {}
            err = None
        except Exception as e:  # keep going; a failed call is a 0
            text, usage, err = "", {}, repr(e)
        return text, usage, err, time.time() - t0


async def run(args):
    recipe = json.loads(Path(args.recipe).read_text())
    cfg = recipe["eval"]
    df = load(args.split)
    if args.limit:
        df = df.head(args.limit)
    client = AsyncOpenAI(base_url=args.base_url, api_key=args.api_key or os.environ.get("OPENAI_API_KEY", "x"))
    sem = asyncio.Semaphore(cfg["concurrency"])
    suffix = recipe["data"]["user_suffix"]
    jobs = [ask(client, args.model, messages_for(r, suffix), cfg, sem, args.thinking) for _, r in df.iterrows()]
    results = await asyncio.gather(*jobs)
    out_dir = RUNS / args.run
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    with (out_dir / "rollouts.jsonl").open("w") as f:
        for (_, r), (text, usage, err, secs) in zip(df.iterrows(), results):
            task = load_task(r["task"])
            g = grade_text(task, text)
            row = {"task_id": r["task_id"], "difficulty": r["difficulty"], "num_ships": int(r["num_ships"]),
                   "answer": text, "error": err, "usage": usage, "seconds": round(secs, 1), **g}
            rows.append(row)
            f.write(json.dumps(row) + "\n")
    n = len(rows)
    by_diff = {}
    for d in sorted({r["difficulty"] for r in rows}):
        rs = [r for r in rows if r["difficulty"] == d]
        by_diff[d] = round(sum(r["reward"] for r in rs) / len(rs), 3)
    summary = {
        "run": args.run, "model": args.model, "split": args.split, "n": n,
        "mean_reward": round(sum(r["reward"] for r in rows) / n, 4),
        "by_difficulty": by_diff,
        "submitted": sum(r["submitted"] for r in rows),
        "feasible": sum(r["feasible"] for r in rows),
        "optimal": sum(1 for r in rows if r["feasible"] and r["cost"] is not None and r["cost"] <= r["optimal_cost"]),
        "errors": sum(1 for r in rows if r["error"]),
        "recipe_version": recipe.get("version"),
        "finished_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    (out_dir / "recipe.json").write_text(json.dumps(recipe, indent=1))
    print(json.dumps(summary, indent=1))
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--split", default="eval")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--thinking", action="store_true", help="leave the model's thinking mode on")
    ap.add_argument("--recipe", default=str(ROOT / "portsim" / "recipe.json"))
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
