// The ONLY place held-out scenarios are generated. Callers must present a frozen champion.
// The optimization loop (orchestrator rounds, agent context) never imports this module.
import { generateSuite, hashString, type Network, type Scenario } from "../sim";
import type { Experiment } from "./types";

export function heldOutSeedBase(runId: string): number {
  return 50000 + (hashString(`heldout:${runId}`) % 40000);
}

export function generateHeldOutSuite(net: Network, exp: Experiment, frozen: { championId: string; frozenAt: string }): Scenario[] {
  if (!frozen.championId || !frozen.frozenAt) throw new Error("Held-out suite requires a frozen champion");
  if (exp.heldOut && exp.heldOut.championId !== frozen.championId) throw new Error("Held-out suite already used for a different champion");
  return generateSuite(
    net,
    "heldout",
    { count: exp.suiteSpecs.heldOut.count, seedBase: heldOutSeedBase(exp.runId), types: exp.suiteSpecs.heldOut.types },
    exp.demand,
  );
}
