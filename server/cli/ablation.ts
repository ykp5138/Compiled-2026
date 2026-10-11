// npm run ablation -- --run <llmRunId> [--seeds 3]
// Control experiment: the SAME improvement loop (same agents count, rounds, scenarios, selection rule)
// but proposals come from random perturbation instead of LLM agents. Each random-search champion is then
// evaluated on the LLM run's held-out suite, so both are compared on identical unseen episodes.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { arg } from "./args";

const llmRunId = arg("run") ?? "run-20261011-164124";
const seeds = Number(arg("seeds") ?? 3);
const tmp = mkdtempSync(path.join(os.tmpdir(), "greenwave-ablation-"));
process.env.EXPERIMENTS_DIR = tmp;
process.env.AGENT_PROVIDER = "mock";
// Random-search control runs are scratch data: never mirror them to MongoDB.
process.env.MONGODB_URI = "";

const { aggregate, compare, getNetwork, makePolicyController, runEpisode } = await import("../../sim");
const { loadExperimentFrom } = await import("./load");
const { Orchestrator } = await import("../orchestrator");
const { MockProvider } = await import("../providers");
const { generateHeldOutSuite } = await import("../heldout");
const { ROOT } = await import("../config");

const net = getNetwork();
const llm = loadExperimentFrom(path.join(ROOT, "experiments"), llmRunId);
if (!llm?.heldOut) throw new Error(`${llmRunId} not found or not frozen`);
const heldOut = generateHeldOutSuite(net, llm, { championId: llm.heldOut.championId, frozenAt: llm.heldOut.frozenAt });
const rounds = llm.rounds.length;
const team = new Set(llm.candidates.map((c) => c.agentId ?? c.role)).size;
console.log(`Control for ${llmRunId}: ${team} random proposers × ${rounds} rounds, ${seeds} seeds; held-out = the LLM run's ${heldOut.length} episodes`);

const evalHeld = (policy: Parameters<typeof makePolicyController>[0]) => {
  const per = heldOut.map((sc) => runEpisode(net, sc, makePolicyController(policy, net)).metrics);
  return { suite: "heldout", perScenario: per, aggregate: aggregate(per) };
};
const heur = { suite: "heldout", ...llm.heldOut.results["baseline-heuristic"] };
const fixed = { suite: "heldout", ...llm.heldOut.results["baseline-fixed"] };
const llmChamp = { suite: "heldout", ...llm.heldOut.results["champion"] };

const results: Record<string, unknown>[] = [];
for (let s = 0; s < seeds; s++) {
  const orch = new Orchestrator();
  orch.provider = new MockProvider();
  await orch.createExperiment();
  // Different seed per repetition: the mock seed hashes the run id; make it unique.
  orch.exp!.runId = `${orch.exp!.runId}-rs${s}`;
  await orch.runRounds(rounds);
  const exp = orch.exp!;
  const champ = orch.policyById(exp.championId)!;
  const held = evalHeld(champ.policy);
  const vsHeur = compare(held, heur);
  const vsFixed = compare(held, fixed);
  const devFinal = exp.championHistory[exp.championHistory.length - 1].devScore;
  console.log(`  random seed ${s}: ${exp.candidates.length} candidates, ${exp.championHistory.length - 1} accepted; dev ${devFinal.toFixed(2)}; held-out ${held.aggregate.score.toFixed(2)} (${vsHeur.relImprovement?.toFixed(1)}% vs heuristic, ${vsHeur.wins}/${vsHeur.losses})`);
  results.push({
    seed: s,
    candidates: exp.candidates.length,
    accepted: exp.championHistory.length - 1,
    devScore: devFinal,
    heldOutScore: held.aggregate.score,
    vsHeuristicPct: vsHeur.relImprovement,
    vsHeuristicWins: vsHeur.wins,
    vsHeuristicLosses: vsHeur.losses,
    vsFixedPct: vsFixed.relImprovement,
    perScenario: held.perScenario.map((m) => ({ scenarioId: m.scenarioId, score: m.score })),
  });
}

const llmVsHeur = compare(llmChamp, heur);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rsHeld = results.map((r) => r.heldOutScore as number);
const rsPct = results.map((r) => r.vsHeuristicPct as number);
// Paired comparison of the LLM champion against each random-search champion on the same episodes.
const llmVsRandom = results.map((r) => {
  const per = r.perScenario as { scenarioId: string; score: number }[];
  const wins = llmChamp.perScenario.filter((m, i) => m.score < per[i].score).length;
  return { seed: r.seed, llmWins: wins, of: per.length, relPct: (100 * (mean(per.map((p) => p.score)) - llmChamp.aggregate.score)) / mean(per.map((p) => p.score)) };
});
// Exact two-sided sign test.
const binom = (n: number, k: number) => {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
};
const signP = (wins: number, n: number) => {
  const k = Math.max(wins, n - wins);
  let p = 0;
  for (let i = k; i <= n; i++) p += binom(n, i);
  return Math.min(1, (2 * p) / 2 ** n);
};

const summary = {
  llmRunId,
  heldOutEpisodes: heldOut.length,
  budget: { proposersPerRound: team, rounds, candidates: llm.candidates.length },
  heuristic: heur.aggregate.score,
  fixed: fixed.aggregate.score,
  llmAgents: {
    heldOutScore: llmChamp.aggregate.score,
    vsHeuristicPct: llmVsHeur.relImprovement,
    wins: llmVsHeur.wins,
    losses: llmVsHeur.losses,
    signTestP: signP(llmVsHeur.wins, llmVsHeur.wins + llmVsHeur.losses),
    devScore: llm.championHistory[llm.championHistory.length - 1].devScore,
  },
  randomSearch: { seeds: results, meanHeldOutScore: mean(rsHeld), meanVsHeuristicPct: mean(rsPct) },
  llmVsRandom,
};
console.log("\nSUMMARY");
console.log(`  heuristic baseline        ${heur.aggregate.score.toFixed(2)} s/veh`);
console.log(`  random search (mean of ${seeds}) ${mean(rsHeld).toFixed(2)} s/veh  (${mean(rsPct).toFixed(1)}% vs heuristic)`);
console.log(`  LLM agents                ${llmChamp.aggregate.score.toFixed(2)} s/veh  (${llmVsHeur.relImprovement?.toFixed(1)}% vs heuristic, ${llmVsHeur.wins}/${llmVsHeur.losses}, sign test p = ${summary.llmAgents.signTestP.toExponential(1)})`);
for (const r of llmVsRandom) console.log(`  LLM vs random seed ${r.seed}: ${r.relPct.toFixed(1)}% better, wins ${r.llmWins}/${r.of} episodes (p = ${signP(r.llmWins, r.of).toFixed(4)})`);
const outDir = path.join(ROOT, "experiments", "ablations");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `ablation-${llmRunId}.json`);
writeFileSync(file, JSON.stringify(summary, null, 1));
console.log(`Saved ${path.relative(ROOT, file)}`);
