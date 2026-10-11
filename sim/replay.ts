// Replay recording: runs the exact same deterministic episode as the benchmark, with frame capture.
import type { Network } from "./network";
import { makePolicyController, type Policy } from "./policy";
import type { Scenario } from "./scenarios";
import { runEpisode, SIM, SIMULATOR_VERSION, type EpisodeMetrics, type Frame } from "./simulator";

export interface Replay {
  simulatorVersion: string;
  scenarioId: string;
  scenarioChecksum: string;
  controllerId: string;
  controllerLabel: string;
  frameEvery: number;
  dt: number;
  horizon: number;
  drain: number;
  scheduled: number;
  frames: Frame[];
  final: EpisodeMetrics;
}

export function recordReplay(net: Network, scenario: Scenario, policy: Policy, controllerId: string, controllerLabel: string): Replay {
  const res = runEpisode(net, scenario, makePolicyController(policy, net, controllerId), { record: true, frameEvery: 1 });
  return {
    simulatorVersion: SIMULATOR_VERSION,
    scenarioId: scenario.id,
    scenarioChecksum: scenario.checksum,
    controllerId,
    controllerLabel,
    frameEvery: 1,
    dt: SIM.dt,
    horizon: scenario.horizon,
    drain: scenario.drain,
    scheduled: scenario.arrivals.length,
    frames: res.frames!,
    final: res.metrics,
  };
}
