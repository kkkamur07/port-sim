"""The Argon loop: Gemini 4 Argon is the ML engineer. It owns recipe.json, launches training and eval, reads every
rollout of the run in one call, and decides what to change next.

    GEMINI_API_KEY=... python -m portsim.agent --loops 4 --gpu-host gpu

Each loop: build data -> train (GPU 0) -> serve + eval (GPU 1) -> Argon reads runs/<loop>/rollouts.jsonl and
train.json -> Argon edits recipe.json and writes runs/<loop>/diagnosis.md -> next loop. Everything Argon does is
logged to runs/agent_log.jsonl so the demo can replay it.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

from google import genai
from google.genai import types

from portsim import ROOT

MODEL = os.environ.get("ARGON_MODEL", "gemini-4-argon")
RECIPE = ROOT / "portsim" / "recipe.json"
RUNS = ROOT / "runs"
LOG = RUNS / "agent_log.jsonl"

SYSTEM = """You are the ML engineer on a one-day project. Goal: raise the mean reward of a small open model
(Qwen3.5-4B, LoRA SFT) on the 50 held-out PortSimEnv eval tasks as high as possible, loop by loop.

PortSimEnv: one container quay at the Port of Barcelona, a disrupted week, the model must output one JSON berth plan
(ship, berth_hour, section, cranes) for every ship. A deterministic checker grades it: any rule break caps the reward
at 0.2 times the clean fraction; a feasible plan scores 0.2 + 0.8 exp(-gap/0.5) against a CP-SAT optimum.
Published board (multi-turn with a check tool, 12 turns): GPT-6.1 Sol 0.888, Claude Sonnet 5.5 0.782,
GLM-5.3-Flash 0.470, Qwen3.8-27B 0.211. Our model answers in a single shot.

You control recipe.json (data filters, repeats, extra examples, user suffix, epochs, lr, rank, max_seq_len). You can
also add extra_examples: full {messages:[system,user,assistant]} items, e.g. hand-repaired plans for the task types
the model fails on. Be concrete and surgical: one or two hypotheses per loop, each tied to evidence in the rollouts.
Keep the base model and the eval protocol fixed so loops are comparable. Write your reasoning in the diagnosis."""


def log(kind: str, **kw):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps({"t": time.time(), "kind": kind, **kw}) + "\n")


def sh(cmd: str, host: str | None) -> str:
    full = cmd if not host else f"ssh {host} 'cd {os.environ.get('REMOTE_ROOT', '~/port-sim')} && {cmd}'"
    log("shell", cmd=full)
    p = subprocess.run(full, shell=True, capture_output=True, text=True)
    out = (p.stdout + p.stderr)[-4000:]
    log("shell_done", cmd=full, rc=p.returncode, tail=out)
    return out


# ---- tools Argon can call -------------------------------------------------------------------------------------

def read_recipe() -> str:
    """Return the current recipe.json."""
    return RECIPE.read_text()


def write_recipe(recipe_json: str, reason: str) -> str:
    """Replace recipe.json with new content. `reason` is one or two sentences for the log."""
    d = json.loads(recipe_json)
    d["version"] = int(d.get("version", 0)) + 1
    RECIPE.write_text(json.dumps(d, indent=1))
    log("recipe", version=d["version"], reason=reason)
    return f"recipe version {d['version']} written"


def read_run(run: str, max_rollouts: int = 50, answers: bool = True) -> str:
    """Everything about one loop: train log, eval summary and the graded rollouts (answers included by default)."""
    d = RUNS / run
    parts = []
    for name in ("summary.json", "train.json"):
        p = d / name
        if p.exists():
            j = json.loads(p.read_text())
            if name == "train.json":
                j["history"] = j["history"][-10:]
            parts.append(f"## {name}\n{json.dumps(j, indent=1)}")
    p = d / "rollouts.jsonl"
    if p.exists():
        rows = [json.loads(l) for l in p.read_text().splitlines()][:max_rollouts]
        if not answers:
            for r in rows:
                r.pop("answer", None)
        parts.append("## rollouts.jsonl\n" + "\n".join(json.dumps(r) for r in rows))
    return "\n\n".join(parts) or f"no run named {run}"


def read_history() -> str:
    """Mean reward and recipe version of every finished loop so far."""
    out = []
    for d in sorted(RUNS.iterdir()):
        s = d / "summary.json"
        if s.exists():
            j = json.loads(s.read_text())
            out.append({k: j.get(k) for k in ("run", "mean_reward", "by_difficulty", "feasible", "optimal", "recipe_version")})
    return json.dumps(out, indent=1)


def read_train_task(task_id: str) -> str:
    """The system prompt, situation and optimal plan of one training task, for writing extra examples."""
    from portsim.data import load
    df = load("train")
    r = df[df.task_id == task_id]
    if r.empty:
        return "no such task"
    r = r.iloc[0]
    return json.dumps({"system_prompt": r.system_prompt, "situation": r.situation, "optimal_plan": r.optimal_plan})


def write_diagnosis(run: str, markdown: str) -> str:
    """Save the diagnosis of a loop (what failed, why, what changes next) to runs/<run>/diagnosis.md."""
    (RUNS / run).mkdir(parents=True, exist_ok=True)
    (RUNS / run / "diagnosis.md").write_text(markdown)
    log("diagnosis", run=run, chars=len(markdown))
    return "saved"


TOOLS = [read_recipe, write_recipe, read_run, read_history, read_train_task, write_diagnosis]


# ---- the loop --------------------------------------------------------------------------------------------------

def train_and_eval(run: str, host: str | None, base: str | None) -> dict:
    py = ".venv/bin/python"
    sh(f"{py} -m portsim.data build", host)
    base_arg = f" --base {base}" if base else ""
    sh(f"CUDA_VISIBLE_DEVICES=0 {py} -m portsim.train_sft --run {run}{base_arg}", host)
    sh(f"pkill -f 'vllm serve' || true", host)
    sh(f"GPU=1 nohup scripts/serve.sh models/{run} 8000 > runs/{run}/serve.log 2>&1 &", host)
    for _ in range(60):  # wait for vLLM
        if "qwen-sft" in sh("curl -s localhost:8000/v1/models", host):
            break
        time.sleep(10)
    out = sh(f"{py} -m portsim.evaluate --run {run} --base-url http://localhost:8000/v1 --model qwen-sft", host)
    if host:  # pull the run directory back
        subprocess.run(f"rsync -a {host}:{os.environ.get('REMOTE_ROOT', '~/port-sim')}/runs/{run}/ runs/{run}/", shell=True)
    s = RUNS / run / "summary.json"
    return json.loads(s.read_text()) if s.exists() else {"error": out}


def argon_turn(client, chat_history: list, prompt: str) -> str:
    cfg = types.GenerateContentConfig(system_instruction=SYSTEM, tools=TOOLS, temperature=0.3,
                                      automatic_function_calling=types.AutomaticFunctionCallingConfig(maximum_remote_calls=30))
    chat = client.chats.create(model=MODEL, config=cfg, history=chat_history)
    r = chat.send_message(prompt)
    chat_history[:] = chat.get_history()
    log("argon", prompt=prompt[:500], reply=(r.text or "")[:4000])
    return r.text or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loops", type=int, default=4)
    ap.add_argument("--gpu-host", default=None, help="ssh host of the A6000 box; omit if running on it")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--continue-from-previous", action="store_true", help="each loop fine-tunes the previous merged model")
    args = ap.parse_args()
    client = genai.Client()
    history: list = []
    prev = None
    for i in range(args.start, args.start + args.loops):
        run = f"loop{i}"
        if i > 1:
            argon_turn(client, history,
                       f"Loop {i-1} has finished. Read its run with read_run('loop{i-1}') and read_history(), diagnose the "
                       f"failure modes you see in the graded rollouts, write the diagnosis with write_diagnosis, then "
                       f"write the recipe for loop {i} with write_recipe. End with one paragraph summarising the change.")
        else:
            argon_turn(client, history, "Read the recipe (read_recipe) and say in three sentences what you expect from loop 1. "
                                        "Do not change anything yet.")
        summary = train_and_eval(run, args.gpu_host, prev if args.continue_from_previous else None)
        prev = f"models/{run}"
        print(json.dumps(summary, indent=1))
    argon_turn(client, history, "All loops are done. Read read_history() and write a final diagnosis to "
                                "write_diagnosis('final', ...): what moved the reward, what did not, and what you would try "
                                "with another day.")


if __name__ == "__main__":
    main()
