// npm run bench — calibrates both baselines on training demand and reports training + development results.
// Never touches held-out scenarios.
import { calibrateFixedBaseline, calibrateHeuristicBaseline, compare, DEFAULT_DEMAND, evaluatePolicy, generateSuite, getNetwork, type ScenarioType } from "../../sim";
import { config } from "../config";

const net = getNetwork();
const demand = { ...DEFAULT_DEMAND, horizon: config.experiment.horizon, drain: config.experiment.drain };
const train = generateSuite(net, "train", { ...config.experiment.train, types: ["balanced", "arterial", "side", "bursty", "shift", "balanced", "bursty", "shift"] as ScenarioType[] }, demand);
const dev = generateSuite(net, "dev", { ...config.experiment.dev, types: ["balanced", "side", "bursty", "shift"] as ScenarioType[] }, demand);
const t0 = Date.now();
const fx = await calibrateFixedBaseline(net, train);
const hx = await calibrateHeuristicBaseline(net, train);
console.log(`Calibrated in ${((Date.now() - t0) / 1000).toFixed(1)} s. Fixed: ${fx.log.chosen}. Heuristic: ${hx.log.chosen}.`);
const rows: [string, ReturnType<typeof evaluatePolicy>, ReturnType<typeof evaluatePolicy>][] = [
  ["Fixed-time", evaluatePolicy(net, fx.policy, train, "train"), evaluatePolicy(net, fx.policy, dev, "dev")],
  ["Heuristic", evaluatePolicy(net, hx.policy, train, "train"), evaluatePolicy(net, hx.policy, dev, "dev")],
];
console.log("\nController    suite  score(s/veh)  completion  P95 wait  side P95  backlog");
for (const [name, tr, dv] of rows) {
  for (const [s, e] of [["train", tr], ["dev", dv]] as const) {
    const a = e.aggregate;
    console.log(`${name.padEnd(13)} ${s.padEnd(6)} ${a.score.toFixed(2).padStart(12)}  ${(a.completionFraction * 100).toFixed(1).padStart(9)}%  ${a.p95Wait.toFixed(0).padStart(7)} s  ${a.sideP95Wait.toFixed(0).padStart(7)} s  ${String(a.externalBacklog + a.inNetwork).padStart(7)}`);
  }
}
const c = compare(rows[1][2], rows[0][2]);
console.log(`\nHeuristic vs fixed on dev: ${c.relImprovement?.toFixed(1)}% (wins ${c.wins}/${c.perScenario.length})`);
