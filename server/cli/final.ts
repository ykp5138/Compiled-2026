// npm run final -- [--run <runId>] — freezes the champion and evaluates on unseen held-out scenarios.
import { arg } from "./args";
import { Orchestrator } from "../orchestrator";

const orch = new Orchestrator();
const runId = arg("run");
if (runId) {
  if (!orch.loadRun(runId)) throw new Error(`Run ${runId} not found`);
} else await orch.init();
const exp = orch.exp!;
if (!exp.heldOut) await orch.freezeAndTest();
const h = exp.heldOut!;
const row = (name: string, key: string) => {
  const a = h.results[key].aggregate;
  console.log(`${name.padEnd(28)} ${a.score.toFixed(2).padStart(8)} s/veh  completion ${(a.completionFraction * 100).toFixed(1)}%  P95 ${a.p95Wait.toFixed(0)} s  side P95 ${a.sideP95Wait.toFixed(0)} s`);
};
console.log(`Held-out suite (${h.manifests.length} unseen episodes), champion ${h.championId} frozen at ${h.frozenAt}`);
row("Fixed-time baseline", "baseline-fixed");
row("Queue-responsive heuristic", "baseline-heuristic");
row("Frozen champion", "champion");
const c = h.comparisons;
const fmt = (x: typeof c.championVsFixed) => `${x.relImprovement === null ? "n/a" : x.relImprovement.toFixed(1) + "%"} (wins ${x.wins}, losses ${x.losses}, per-scenario mean ${x.meanRel.toFixed(1)}% ± ${x.sdRel.toFixed(1)})`;
console.log(`Champion vs fixed:     ${fmt(c.championVsFixed)}`);
console.log(`Champion vs heuristic: ${fmt(c.championVsHeuristic)}`);
