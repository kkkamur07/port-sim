// Node tests for the pure run builders in runs.js: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const R = require("../runs.js");

const rows = [
  { version: 0, parent: null, role: "baseline", eval_mean: 0.4, verdict: "accepted", reason: "root", per_task: [{ task_id: "a", reward: 0.4 }, { task_id: "b", reward: 0.4 }] },
  { version: 1, parent: 0, role: "candidate", coach_round: 1, eval_mean: 0.5, current_eval_mean: 0.4, train_mean: 0.6, current_train_mean: 0.55, verdict: "accepted", reason: "eval gain +0.100", change: "rule one",
    per_task: [{ task_id: "a", reward: 0.6 }, { task_id: "b", reward: 0.4 }], train_per_task: [{}, {}, {}] },
  { version: 2, parent: 1, role: "candidate", coach_round: 2, eval_mean: 0.45, train_mean: 0.7, verdict: "rejected", reason: "overfit: train up, eval down", per_task: [{ task_id: "a", reward: 0.3 }], train_per_task: [{}, {}, {}] },
  { version: 3, parent: 1, role: "candidate", coach_round: 3, eval_mean: null, train_mean: 0.5, verdict: "rejected", reason: "minibatch: no gain on the window" },
  { version: 4, parent: 1, role: "candidate", coach_round: 4, eval_mean: 0.48, verdict: "rejected", reason: "no eval gain" },
  { version: 5, parent: 1, role: "candidate", coach_round: 5, eval_mean: 0.62, verdict: "accepted", reason: "eval gain" },
];

test("parseJSONL skips blank and half-written lines", () => {
  assert.deepEqual(R.parseJSONL('{"a":1}\n\n{"b":2}\n{"c":'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(R.parseJSONL(""), []);
});

test("verdict classes and colours", () => {
  assert.deepEqual(rows.map(R.verdictClass), ["baseline", "accepted", "overfit", "minibatch", "rejected", "accepted"]);
  const ev = R.evolution(rows);
  assert.deepEqual(ev.points.map((p) => p.color), [R.COLORS.accepted, R.COLORS.overfit, R.COLORS.minibatch, R.COLORS.rejected, R.COLORS.accepted]);
  assert.equal(R.COLORS.accepted, "#5ad48a");
  assert.equal(R.COLORS.rejected, "#ff5a5a");
});

test("evolution: baseline, lineage step values per round, candidate points", () => {
  const ev = R.evolution(rows);
  assert.equal(ev.baseline, 0.4);
  assert.equal(ev.rounds, 5);
  assert.deepEqual(ev.lineage.map((p) => p.value), [0.4, 0.5, 0.5, 0.5, 0.5, 0.62]);
  assert.deepEqual(ev.lineage.map((p) => p.version), [0, 1, 1, 1, 1, 5]);
  assert.deepEqual(ev.points.map((p) => p.round), [1, 2, 3, 4, 5]);
  assert.equal(ev.points[2].eval, null);
  assert.equal(ev.points[0].train, 0.6);
  assert.equal(ev.points[0].change, "rule one");
});

test("evolution tolerates missing rows and fields", () => {
  const ev = R.evolution([]);
  assert.equal(ev.baseline, null);
  assert.equal(ev.rounds, 0);
  assert.deepEqual(ev.lineage, [{ round: 0, value: null, version: 0 }]);
  const ev2 = R.evolution([{ version: 1, parent: 0, role: "candidate", verdict: "accepted", eval_mean: 0.3 }]);
  assert.deepEqual(ev2.lineage.map((p) => p.value), [null, 0.3]);
});

test("coachRounds: newest first, before and after, per-task deltas vs the parent", () => {
  const list = R.coachRounds(rows);
  assert.deepEqual(list.map((r) => r.version), [5, 4, 3, 2, 1]);
  assert.deepEqual(list.map((r) => r.badge), ["ACCEPTED", "REJECTED", "MINIBATCH", "OVERFIT", "ACCEPTED"]);
  const v1 = list[4];
  assert.equal(v1.evalBefore, 0.4);
  assert.equal(v1.evalAfter, 0.5);
  assert.equal(v1.trainBefore, 0.55);
  assert.equal(v1.trainAfter, 0.6);
  assert.deepEqual(v1.perTask.map((t) => Math.round(t.delta * 1000) / 1000), [0.2, 0]);
  // no current_eval_mean: falls back to the parent's eval mean
  assert.equal(list[3].evalBefore, 0.5);
  assert.equal(list[3].perTask[0].before, 0.6);
});

test("currentPlaybook: the last accepted version and its accepted parent", () => {
  assert.deepEqual(R.currentPlaybook(rows, null), { version: 5, previous: 1 });
  assert.deepEqual(R.currentPlaybook(rows.slice(0, 1), null), { version: 0, previous: null });
  const tree = { nodes: [{ version: 0, parent: null, verdict: "accepted" }, { version: 1, parent: 0, verdict: "accepted" }] };
  assert.deepEqual(R.currentPlaybook([], tree), { version: 1, previous: 0 });
});

test("playbookDiff flags only the added lines", () => {
  const prev = "# Playbook v0\n\n## Rules\n- keep cranes in the pool\n\n## Checklist\n1. read";
  const cur = "# Playbook v1\n\n## Rules\n- keep cranes in the pool\n- never berth in fog\n\n## Checklist\n1. read";
  const d = R.playbookDiff(prev, cur);
  assert.deepEqual(d.filter((l) => l.added).map((l) => l.text), ["# Playbook v1", "- never berth in fog"]);
  assert.equal(d.length, cur.split("\n").length);
  assert.ok(R.playbookDiff(null, cur).every((l) => !l.added));
});

test("roundMarkers place each round after its episode window", () => {
  const eps = Array.from({ length: 15 }, (_, i) => ({ episode: i + 1 }));
  const mk = R.roundMarkers(rows, eps);
  assert.deepEqual(mk.map((m) => m.episode), [3, 6, 9, 12, 15]);
  assert.equal(mk[0].label, "v1 accepted");
  assert.equal(mk[3].label, "v4 rejected");
});

test("uiText never says train or eval", () => {
  assert.equal(R.uiText("no eval gain: eval +0.001 (needs +0.005)"), "no verification gain: verification +0.001 (needs +0.005)");
  assert.equal(R.uiText("overfit: train up, Eval down"), "overfit: episode up, Verification down");
  assert.equal(R.uiText("retrain evaluate"), "retrain evaluate");
  const list = R.coachRounds([{ version: 1, parent: 0, coach_round: 1, verdict: "rejected", reason: "no eval gain", diagnosis: "train mean 0.4" }]);
  assert.equal(list[0].reason, "no verification gain");
  assert.equal(list[0].diagnosis, "episode mean 0.4");
});

test("movingAverage and runHeader", () => {
  assert.deepEqual(R.movingAverage([0.3, null, 0.6, 0.9], 3), [0.3, 0.3, 0.45, 0.75]);
  const h = R.runHeader([{ episode: 1, cost_usd: 0.01, playbook_version: 0 }, { episode: 2, cost_usd: 0.02, playbook_version: 1 }], [{ role: "baseline", version: 0, eval_cost_usd: 0.1 }, { version: 1, parent: 0, coach_round: 1, verdict: "accepted", coach_cost_usd: 0.005 }]);
  assert.deepEqual(h, { episode: 2, episodes: 2, playbook: 1, cost_usd: 0.135 });
});

test("the bundled real run fixture builds", () => {
  const dir = new URL("../fixtures/run-demo/", import.meta.url);
  const ev = R.parseJSONL(readFileSync(new URL("eval.jsonl", dir), "utf8"));
  const eps = R.parseJSONL(readFileSync(new URL("episodes.jsonl", dir), "utf8"));
  const evo = R.evolution(ev);
  assert.equal(evo.rounds, 4);
  assert.equal(evo.lineage.length, 5);
  assert.deepEqual(R.roundMarkers(ev, eps).map((m) => m.episode), [4, 8, 12, 16]);
  assert.equal(R.coachRounds(ev)[0].version, 4);
  // round 2 accepted (verification 0.360 -> 0.429), round 4 overfit
  assert.deepEqual(evo.points.map((p) => p.cls), ["rejected", "accepted", "rejected", "overfit"]);
  assert.deepEqual(evo.lineage.map((p) => p.value), [0.3596, 0.3596, 0.4288, 0.4288, 0.4288]);
  assert.deepEqual(R.currentPlaybook(ev, null), { version: 2, previous: 0 });
});
