// Baseline controllers, both expressed in the same policy schema and calibrated on TRAINING demand only.
// 1. Fixed-time: Webster cycle/splits from training flows, progression offsets, small cycle grid search.
// 2. Queue-responsive heuristic: conventional actuated-style logic using upstream queues and downstream capacity.
import type { Network } from "./network";
import { evaluatePolicy } from "./evaluate";
import type { AdaptiveParams, FixedPlan, Policy } from "./policy";
import type { Scenario } from "./scenarios";
import { CLEARANCE, SIM } from "./simulator";

export const FIXED_BASELINE_ID = "baseline-fixed";
export const HEURISTIC_BASELINE_ID = "baseline-heuristic";

const SAT_FLOW = 3600 / SIM.satHeadway; // veh/h/lane

/** Average hourly flow per movement over the training scenarios. */
export function movementFlows(net: Network, scenarios: Scenario[]): number[] {
  const counts = new Array(net.movements.length).fill(0);
  let hours = 0;
  for (const sc of scenarios) {
    hours += sc.horizon / 3600;
    for (const a of sc.arrivals) {
      for (let i = 0; i + 1 < a.route.length; i++) {
        const m = net.movementByPair.get(`${a.route[i]}>${a.route[i + 1]}`);
        if (m) counts[m.idx]++;
      }
    }
  }
  return counts.map((c) => (hours > 0 ? c / hours : 0));
}

export function criticalRatios(net: Network, flows: number[]): number[][] {
  return net.intersections.map((inter) =>
    inter.phases.map((ph) => {
      const byLink = new Map<number, number>();
      for (const mi of ph.movements) {
        const m = net.movements[mi];
        byLink.set(m.from, (byLink.get(m.from) ?? 0) + flows[mi]);
      }
      let crit = 0;
      for (const [li, f] of byLink) crit = Math.max(crit, f / net.links[li].lanes);
      return crit / SAT_FLOW;
    }),
  );
}

function splitsFor(y: number[], cycle: number): number[] {
  const n = y.length;
  const eff = cycle - n * CLEARANCE;
  const minG = SIM.minGreen + 1;
  const maxG = SIM.maxGreen;
  const w = y.map((v) => Math.max(v, 0.03));
  let g = w.map((v) => (v / w.reduce((a, b) => a + b, 0)) * eff);
  for (let iter = 0; iter < 5; iter++) {
    const fixedIdx = g.map((x) => x < minG || x > maxG);
    g = g.map((x) => Math.min(maxG, Math.max(minG, x)));
    const spare = eff - g.reduce((a, b) => a + b, 0);
    const free = g.map((_, i) => !fixedIdx[i]);
    const freeSum = g.reduce((a, x, i) => a + (free[i] ? x : 0), 0);
    if (Math.abs(spare) < 1e-6 || freeSum === 0) break;
    g = g.map((x, i) => (free[i] ? x + (spare * x) / freeSum : x));
  }
  const total = g.reduce((a, b) => a + b, 0);
  return g.map((x) => +(x / total).toFixed(4));
}

/**
 * Progression offsets: along each one-way corridor served by phase 0, an intersection's phase-0 green starts when a
 * platoon released by the upstream signal arrives (sum of free-flow travel times from the corridor's first signal).
 * Intersections whose phase 0 has more than one approach (two-way) get offset 0.
 */
function progressionOffsets(net: Network, cycle: number): Record<string, number> {
  const memo = new Map<number, number>();
  const tt = (li: number) => (net.links[li].length + 2 * net.raw.intersectionInset) / net.links[li].speed;
  const offsetOf = (ii: number, depth = 0): number => {
    if (memo.has(ii)) return memo.get(ii)!;
    const inter = net.intersections[ii];
    const approaches = [...new Set(inter.phases[0].movements.map((mi) => net.movements[mi].from))];
    let off = 0;
    if (approaches.length === 1 && depth < 50) {
      const link = net.links[approaches[0]];
      const upstream = net.intersections.findIndex((x) => x.id === link.from);
      if (link.kind === "internal" && upstream >= 0) off = offsetOf(upstream, depth + 1) + tt(link.idx);
    }
    memo.set(ii, off);
    return off;
  };
  const out: Record<string, number> = {};
  net.intersections.forEach((inter, ii) => (out[inter.id] = +(offsetOf(ii) % cycle).toFixed(1)));
  return out;
}

export function defaultAdaptive(nPhases: number): AdaptiveParams {
  return {
    minHold: 10,
    maxGreen: Array.from({ length: nPhases }, (_, p) => (p === 0 ? 50 : 35)),
    weights: { queue: 1, approaching: 0.6, oldestWait: 0.04, downstream: 0.8 },
    phaseBias: Array.from({ length: nPhases }, () => 0),
    hysteresis: 2,
  };
}

export function buildFixedPolicy(net: Network, flows: number[], cycle: number, progression: boolean, sideScale = 1): Policy | null {
  const y = criticalRatios(net, flows).map((ys) => ys.map((v, p) => (p === 0 ? v : v * sideScale)));
  // Skip cycles too short to give every phase the simulator minimum green.
  if (net.intersections.some((i) => cycle - i.phases.length * CLEARANCE < i.phases.length * (SIM.minGreen + 1))) return null;
  const offsets = progression ? progressionOffsets(net, cycle) : {};
  const intersections: Policy["intersections"] = {};
  net.intersections.forEach((inter, i) => {
    const fixed: FixedPlan = { cycle, splits: splitsFor(y[i], cycle), offset: offsets[inter.id] ?? 0 };
    intersections[inter.id] = { mode: "fixed", fixed, adaptive: defaultAdaptive(inter.phases.length) };
  });
  return { schemaVersion: 1, intersections, coordination: { enabled: false, cycle, windows: [] } };
}

export interface CalibrationLog {
  description: string;
  trials: { label: string; trainScore: number }[];
  chosen: string;
}

/** Webster's optimal cycle, then a small grid search on training scenarios. */
export async function calibrateFixedBaseline(net: Network, train: Scenario[], yieldFn: () => Promise<void> = async () => undefined): Promise<{ policy: Policy; log: CalibrationLog }> {
  const flows = movementFlows(net, train);
  const y = criticalRatios(net, flows);
  const webster = y.map((ys) => {
    const Y = Math.min(0.9, ys.reduce((a, b) => a + b, 0));
    const L = ys.length * CLEARANCE;
    return (1.5 * L + 5) / (1 - Y);
  });
  const c0 = Math.round(Math.min(120, Math.max(40, Math.max(...webster))) / 5) * 5;
  const trials: CalibrationLog["trials"] = [];
  let best: { policy: Policy; score: number; label: string } | null = null;
  const cycles = [...new Set([40, 50, 60, 70, 80, 90, 100, 110, 120, c0])].sort((a, b) => a - b);
  for (const cycle of cycles) {
    for (const progression of [true, false]) {
      for (const sideScale of [1, 1.3]) {
        const policy = buildFixedPolicy(net, flows, cycle, progression, sideScale);
        if (!policy) continue;
        const score = evaluatePolicy(net, policy, train).aggregate.score;
        await yieldFn();
        const label = `cycle ${cycle} s, ${progression ? "progression offsets" : "zero offsets"}, cross-street split ×${sideScale}`;
        trials.push({ label, trainScore: +score.toFixed(3) });
        if (!best || score < best.score) best = { policy, score, label };
      }
    }
  }
  return {
    policy: best!.policy,
    log: {
      description: `Webster cycle from training flows = ${c0} s (common cycle); splits proportional to critical lane flow ratios; grid search over cycle and offsets on training scenarios only.`,
      trials,
      chosen: best!.label,
    },
  };
}

export function buildHeuristicPolicy(net: Network, params: Partial<AdaptiveParams> & { approaching?: number } = {}): Policy {
  const intersections: Policy["intersections"] = {};
  for (const inter of net.intersections) {
    const a = defaultAdaptive(inter.phases.length);
    if (params.minHold !== undefined) a.minHold = params.minHold;
    if (params.hysteresis !== undefined) a.hysteresis = params.hysteresis;
    if (params.approaching !== undefined) a.weights.approaching = params.approaching;
    a.maxGreen = a.maxGreen.map((g) => Math.max(g, a.minHold));
    intersections[inter.id] = { mode: "adaptive", fixed: { cycle: 90, splits: inter.phases.map(() => 1 / inter.phases.length), offset: 0 }, adaptive: a };
  }
  return { schemaVersion: 1, intersections, coordination: { enabled: false, cycle: 90, windows: [] } };
}

/** Small grid over conventional actuation parameters on training scenarios. */
export async function calibrateHeuristicBaseline(net: Network, train: Scenario[], yieldFn: () => Promise<void> = async () => undefined): Promise<{ policy: Policy; log: CalibrationLog }> {
  const trials: CalibrationLog["trials"] = [];
  let best: { policy: Policy; score: number; label: string } | null = null;
  for (const minHold of [12, 16, 20]) {
    for (const hysteresis of [3, 6]) {
      for (const approaching of [0.4, 0.8]) {
        const policy = buildHeuristicPolicy(net, { minHold, hysteresis, approaching });
        const score = evaluatePolicy(net, policy, train).aggregate.score;
        await yieldFn();
        const label = `minHold ${minHold} s, hysteresis ${hysteresis}, approaching weight ${approaching}`;
        trials.push({ label, trainScore: +score.toFixed(3) });
        if (!best || score < best.score) best = { policy, score, label };
      }
    }
  }
  return {
    policy: best!.policy,
    log: {
      description: "Queue-responsive actuation: serve the phase with the most stopped + approaching vehicles (plus a small oldest-wait term), discounted by receiving-link occupancy; grid search on training scenarios only.",
      trials,
      chosen: best!.label,
    },
  };
}
