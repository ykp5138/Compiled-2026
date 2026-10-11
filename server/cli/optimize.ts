// npm run optimize -- [--run <runId> | --new] [--rounds N]
import { arg, flag } from "./args";
import { config } from "../config";
import { Orchestrator } from "../orchestrator";

const orch = new Orchestrator();
orch.on("log", (e: { at: string; role?: string; text: string }) => {
  console.log(`[${e.at.slice(11, 19)}]${e.role ? ` ${e.role.padEnd(10)}` : " "} ${e.text}`);
});
const runId = arg("run");
if (flag("new")) await orch.createExperiment();
else if (runId) {
  if (!orch.loadRun(runId)) throw new Error(`Run ${runId} not found`);
} else await orch.init();
const rounds = Number(arg("rounds") ?? config.experiment.rounds);
console.log(`Run ${orch.exp!.runId}: ${rounds} round(s) with ${orch.provider.info().label}`);
await orch.runRounds(rounds);
const exp = orch.exp!;
console.log("\nChampion history:");
for (const h of exp.championHistory) console.log(`  round ${h.round}: ${h.policyId} "${h.label}" train ${h.trainScore.toFixed(2)} dev ${h.devScore.toFixed(2)}`);
console.log(`Saved experiments/${exp.runId}/experiment.json`);
