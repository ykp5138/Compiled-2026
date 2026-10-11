// Synthetic demand scenarios. Every arrival (time, origin, destination, route) is generated
// up front from the scenario seed, so all controllers see byte-identical demand.
// These are synthetic patterns, NOT measured State College traffic.
import type { Network } from "./network";
import { hashNumbers, hashString, mulberry32 } from "./rng";

export type ScenarioType = "balanced" | "arterial" | "side" | "bursty" | "shift";
export type SuiteName = "train" | "dev" | "heldout";

export const SCENARIO_TYPES: ScenarioType[] = ["balanced", "arterial", "side", "bursty", "shift"];

export const SCENARIO_DESCRIPTIONS: Record<ScenarioType, string> = {
  balanced: "Balanced synthetic demand on all approaches",
  arterial: "Arterial-heavy: College and Beaver loaded, side streets light",
  side: "Side-street-heavy: Allen, Pugh and Atherton loaded",
  bursty: "Bursty/event-style: short demand pulses on random approaches",
  shift: "Demand shift: arterial-heavy first half, side-street-heavy second half",
};

export interface Arrival {
  id: number;
  t: number;
  origin: number; // entry link index
  dest: number; // exit link index
  route: number[]; // link indices, entry ... exit
}

export interface ScenarioManifest {
  id: string;
  suite: SuiteName;
  type: ScenarioType;
  seed: number;
  horizon: number;
  drain: number;
  vehicles: number;
  checksum: string;
  description: string;
}

export interface Scenario extends ScenarioManifest {
  arrivals: Arrival[];
}

export interface SuiteSpec {
  count: number;
  seedBase: number;
  types?: ScenarioType[];
}

export interface DemandConfig {
  horizon: number; // seconds of arrivals
  drain: number; // bounded drain period after the horizon, identical for all controllers
  dt: number; // generation / simulation step
}

export const DEFAULT_DEMAND: DemandConfig = { horizon: 900, drain: 300, dt: 0.5 };

interface Pulse {
  start: number;
  end: number;
  origins: Set<string>;
  mult: number;
}

function multiplierFn(net: Network, type: ScenarioType, horizon: number, rng: () => number) {
  const d = net.raw.demand;
  const cls = (o: string) =>
    d.sideStreetOrigins.includes(o) ? "side" : d.arterialOrigins.includes(o) ? "art" : "cross";
  const table: Record<string, Record<string, number>> = {
    balanced: { art: 1, cross: 1, side: 1 },
    arterial: { art: 1.25, cross: 0.9, side: 0.8 },
    side: { art: 0.85, cross: 1.1, side: 2.2 },
    bursty: { art: 0.85, cross: 0.85, side: 0.9 },
    shiftA: { art: 1.2, cross: 0.9, side: 0.7 },
    shiftB: { art: 0.85, cross: 1.15, side: 2.0 },
  };
  const pulses: Pulse[] = [];
  if (type === "bursty") {
    const origins = Object.keys(d.baseVehPerHour);
    const n = 3;
    for (let i = 0; i < n; i++) {
      const start = 60 + rng() * (horizon - 200);
      const dur = 60 + rng() * 40;
      const picked = new Set<string>();
      const k = 2 + Math.floor(rng() * 2);
      while (picked.size < k) picked.add(origins[Math.floor(rng() * origins.length)]);
      pulses.push({ start, end: start + dur, origins: picked, mult: 2.2 + rng() * 0.8 });
    }
  }
  return (origin: string, t: number) => {
    const c = cls(origin);
    let key: string = type;
    if (type === "shift") key = t < horizon / 2 ? "shiftA" : "shiftB";
    let m = table[key][c];
    for (const p of pulses) if (t >= p.start && t < p.end && p.origins.has(origin)) m *= p.mult;
    return m;
  };
}

export function generateScenario(
  net: Network,
  suite: SuiteName,
  type: ScenarioType,
  seed: number,
  cfg: DemandConfig = DEFAULT_DEMAND,
): Scenario {
  const rng = mulberry32(hashString(`${suite}:${type}:${seed}`));
  const d = net.raw.demand;
  const globalJitter = 0.92 + rng() * 0.16;
  const originJitter: Record<string, number> = {};
  for (const o of Object.keys(d.baseVehPerHour)) originJitter[o] = 0.9 + rng() * 0.2;
  const mult = multiplierFn(net, type, cfg.horizon, rng);

  const arrivals: Arrival[] = [];
  const steps = Math.round(cfg.horizon / cfg.dt);
  const origins = Object.keys(d.baseVehPerHour);
  for (let s = 0; s < steps; s++) {
    const t = s * cfg.dt;
    for (const o of origins) {
      const rate = d.baseVehPerHour[o] * globalJitter * originJitter[o] * mult(o, t); // veh/h
      const p = Math.min(0.95, (rate * cfg.dt) / 3600);
      if (rng() < p) {
        const shares = d.destinationShares[o];
        let u = rng();
        let dest = Object.keys(shares)[0];
        for (const [k, v] of Object.entries(shares)) {
          if (u < v) {
            dest = k;
            break;
          }
          u -= v;
        }
        const oi = net.linkById.get(o)!.idx;
        const di = net.linkById.get(dest)!.idx;
        arrivals.push({ id: arrivals.length, t, origin: oi, dest: di, route: net.routes.get(`${oi}>${di}`)! });
      }
    }
  }
  const checksum = hashNumbers(arrivals.flatMap((a) => [a.t, a.origin, a.dest]));
  return {
    id: `${suite}-${type}-${seed}`,
    suite,
    type,
    seed,
    horizon: cfg.horizon,
    drain: cfg.drain,
    vehicles: arrivals.length,
    checksum,
    description: SCENARIO_DESCRIPTIONS[type],
    arrivals,
  };
}

export function generateSuite(net: Network, suite: SuiteName, spec: SuiteSpec, cfg: DemandConfig = DEFAULT_DEMAND): Scenario[] {
  const types = spec.types ?? SCENARIO_TYPES;
  const out: Scenario[] = [];
  for (let i = 0; i < spec.count; i++) {
    out.push(generateScenario(net, suite, types[i % types.length], spec.seedBase + i, cfg));
  }
  return out;
}

export function manifestOf(s: Scenario): ScenarioManifest {
  const { arrivals: _a, ...m } = s;
  return m;
}
