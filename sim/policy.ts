// Declarative controller policies: schema, validation and a deterministic interpreter.
// Agents never write executable code; they emit JSON matching this schema.
import type { Network } from "./network";
import { CLEARANCE, SIM, type Controller, type Observation } from "./simulator";

export interface FixedPlan {
  /** Cycle length in seconds, including clearance intervals. */
  cycle: number;
  /** Green split per phase (fractions of effective green time, sum to 1). */
  splits: number[];
  /** Offset in seconds: cycle starts at t = offset (mod cycle) with phase 0 green. */
  offset: number;
}

export interface AdaptiveParams {
  /** Minimum time to hold a green before the policy may request a switch (>= simulator min green). */
  minHold: number;
  /** Policy-level max green per phase (<= simulator max green). */
  maxGreen: number[];
  weights: {
    queue: number;
    approaching: number;
    oldestWait: number;
    /** 0..1: how strongly downstream occupancy discounts a phase's pressure. */
    downstream: number;
  };
  /** Additive score bias per phase. */
  phaseBias: number[];
  /** Score margin a competing phase must exceed before switching. */
  hysteresis: number;
}

export interface IntersectionPolicy {
  mode: "fixed" | "adaptive";
  fixed: FixedPlan;
  adaptive: AdaptiveParams;
}

export interface CoordinationWindow {
  intersection: string;
  phase: number;
  /** Start of the window within the coordination cycle (s). */
  offset: number;
  /** Window length (s). */
  length: number;
  /** Score bonus added to `phase` while inside the window. */
  bonus: number;
}

export interface Coordination {
  enabled: boolean;
  cycle: number;
  windows: CoordinationWindow[];
}

export interface Policy {
  schemaVersion: 1;
  intersections: Record<string, IntersectionPolicy>;
  coordination: Coordination;
}

export const BOUNDS = {
  cycle: [40, 150],
  minHold: [SIM.minGreen, 30],
  maxGreen: [10, SIM.maxGreen],
  weightQueue: [0, 5],
  weightApproaching: [0, 5],
  weightOldestWait: [0, 1],
  weightDownstream: [0, 1],
  phaseBias: [-10, 10],
  hysteresis: [0, 20],
  coordCycle: [40, 150],
  windowBonus: [0, 50],
  maxWindows: 12,
} as const;

export const POLICY_SCHEMA_DOC = `Policy JSON (schemaVersion 1). All six intersections are required.
{
  "schemaVersion": 1,
  "intersections": {
    "<ID>": {                       // IDs: C_ATH, C_ALL, C_PUG, B_ATH, B_ALL, B_PUG
      "mode": "fixed" | "adaptive",  // which block controls this intersection
      "fixed": {
        "cycle": number,             // ${BOUNDS.cycle[0]}..${BOUNDS.cycle[1]} s, includes ${CLEARANCE} s clearance per phase
        "splits": [number, number],  // one per phase, fractions summing to 1 of (cycle - phases*${CLEARANCE})
        "offset": number             // 0..cycle s; phase 0 green starts at t = offset (mod cycle)
      },
      "adaptive": {
        "minHold": number,           // ${BOUNDS.minHold[0]}..${BOUNDS.minHold[1]} s before the policy may switch
        "maxGreen": [number, number],// per phase, ${BOUNDS.maxGreen[0]}..${BOUNDS.maxGreen[1]} s and >= minHold
        "weights": {
          "queue": number,           // ${BOUNDS.weightQueue[0]}..${BOUNDS.weightQueue[1]} per stopped vehicle
          "approaching": number,     // ${BOUNDS.weightApproaching[0]}..${BOUNDS.weightApproaching[1]} per moving vehicle within ${SIM.approachWindow} m
          "oldestWait": number,      // ${BOUNDS.weightOldestWait[0]}..${BOUNDS.weightOldestWait[1]} per second of the longest current wait
          "downstream": number       // ${BOUNDS.weightDownstream[0]}..${BOUNDS.weightDownstream[1]}: pressure *= (1 - downstream * receivingOccupancy)
        },
        "phaseBias": [number, number], // ${BOUNDS.phaseBias[0]}..${BOUNDS.phaseBias[1]} added to each phase score
        "hysteresis": number         // ${BOUNDS.hysteresis[0]}..${BOUNDS.hysteresis[1]} margin needed to switch away from the current green
      }
    }
  },
  "coordination": {
    "enabled": boolean,
    "cycle": number,                 // ${BOUNDS.coordCycle[0]}..${BOUNDS.coordCycle[1]} s shared coordination cycle
    "windows": [                     // up to ${BOUNDS.maxWindows}; applies to adaptive intersections only
      { "intersection": "<ID>", "phase": 0|1, "offset": number, "length": number, "bonus": number }
      // offset in [0, cycle), length in (0, cycle], bonus ${BOUNDS.windowBonus[0]}..${BOUNDS.windowBonus[1]}
    ]
  }
}
Adaptive phase score = (queue*Q + approaching*A + oldestWait*W) * (1 - downstream*occupancy) + phaseBias + window bonus.
The simulator independently enforces min green ${SIM.minGreen} s, max green ${SIM.maxGreen} s, yellow ${SIM.yellow} s, all-red ${SIM.allRed} s,
and serves any phase with waiting demand after ${SIM.maxRedWait} s of red. Policies cannot change these.`;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  policy?: Policy;
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function validatePolicy(input: unknown, net: Network): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["policy must be a JSON object"], warnings };
  }
  const p = input as Record<string, unknown>;
  if (p.schemaVersion !== 1) err("schemaVersion must be 1");
  const inBounds = (path: string, v: unknown, [lo, hi]: readonly [number, number]) => {
    if (!isNum(v)) err(`${path} must be a finite number`);
    else if (v < lo - 1e-9 || v > hi + 1e-9) err(`${path}=${v} outside [${lo}, ${hi}]`);
  };
  const ints = p.intersections as Record<string, unknown> | undefined;
  const out: Policy = { schemaVersion: 1, intersections: {}, coordination: { enabled: false, cycle: 90, windows: [] } };
  if (typeof ints !== "object" || ints === null) {
    err("intersections must be an object keyed by intersection ID");
  } else {
    for (const key of Object.keys(ints)) if (!net.intersectionById.has(key)) err(`unknown intersection ID ${key}`);
    for (const inter of net.intersections) {
      const ip = ints[inter.id] as Record<string, unknown> | undefined;
      const path = `intersections.${inter.id}`;
      const nP = inter.phases.length;
      if (typeof ip !== "object" || ip === null) {
        err(`${path} missing`);
        continue;
      }
      if (ip.mode !== "fixed" && ip.mode !== "adaptive") err(`${path}.mode must be "fixed" or "adaptive"`);
      const f = ip.fixed as Record<string, unknown> | undefined;
      const a = ip.adaptive as Record<string, unknown> | undefined;
      let fixed: FixedPlan | undefined;
      let adaptive: AdaptiveParams | undefined;
      if (typeof f !== "object" || f === null) err(`${path}.fixed missing`);
      else {
        inBounds(`${path}.fixed.cycle`, f.cycle, BOUNDS.cycle);
        const splits = f.splits;
        if (!Array.isArray(splits) || splits.length !== nP || !splits.every(isNum)) {
          err(`${path}.fixed.splits must be an array of ${nP} numbers`);
        } else if (isNum(f.cycle)) {
          const sum = splits.reduce((s: number, x: number) => s + x, 0);
          if (splits.some((x: number) => x <= 0)) err(`${path}.fixed.splits must be positive`);
          else if (Math.abs(sum - 1) > 0.02) err(`${path}.fixed.splits sum to ${sum.toFixed(3)}, expected 1`);
          else {
            const norm = splits.map((x: number) => x / sum);
            const eff = f.cycle - nP * CLEARANCE;
            norm.forEach((s: number, i: number) => {
              const g = s * eff;
              if (g < SIM.minGreen - 1e-6 || g > SIM.maxGreen + 1e-6) {
                err(`${path}.fixed: phase ${i} green ${g.toFixed(1)} s outside [${SIM.minGreen}, ${SIM.maxGreen}] (cycle ${f.cycle}, split ${s.toFixed(3)})`);
              }
            });
            if (!isNum(f.offset) || f.offset < 0 || f.offset >= f.cycle) err(`${path}.fixed.offset must be in [0, cycle)`);
            fixed = { cycle: f.cycle, splits: norm, offset: isNum(f.offset) ? f.offset : 0 };
          }
        }
      }
      if (typeof a !== "object" || a === null) err(`${path}.adaptive missing`);
      else {
        inBounds(`${path}.adaptive.minHold`, a.minHold, BOUNDS.minHold);
        const mg = a.maxGreen;
        if (!Array.isArray(mg) || mg.length !== nP) err(`${path}.adaptive.maxGreen must be an array of ${nP} numbers`);
        else mg.forEach((x: unknown, i: number) => {
          inBounds(`${path}.adaptive.maxGreen[${i}]`, x, BOUNDS.maxGreen);
          if (isNum(x) && isNum(a.minHold) && x < a.minHold) err(`${path}.adaptive.maxGreen[${i}] must be >= minHold`);
        });
        const w = a.weights as Record<string, unknown> | undefined;
        if (typeof w !== "object" || w === null) err(`${path}.adaptive.weights missing`);
        else {
          inBounds(`${path}.adaptive.weights.queue`, w.queue, BOUNDS.weightQueue);
          inBounds(`${path}.adaptive.weights.approaching`, w.approaching, BOUNDS.weightApproaching);
          inBounds(`${path}.adaptive.weights.oldestWait`, w.oldestWait, BOUNDS.weightOldestWait);
          inBounds(`${path}.adaptive.weights.downstream`, w.downstream, BOUNDS.weightDownstream);
        }
        const pb = a.phaseBias;
        if (!Array.isArray(pb) || pb.length !== nP) err(`${path}.adaptive.phaseBias must be an array of ${nP} numbers`);
        else pb.forEach((x: unknown, i: number) => inBounds(`${path}.adaptive.phaseBias[${i}]`, x, BOUNDS.phaseBias));
        inBounds(`${path}.adaptive.hysteresis`, a.hysteresis, BOUNDS.hysteresis);
        if (errors.length === 0 && w) {
          adaptive = {
            minHold: a.minHold as number,
            maxGreen: (mg as number[]).slice(),
            weights: {
              queue: w.queue as number,
              approaching: w.approaching as number,
              oldestWait: w.oldestWait as number,
              downstream: w.downstream as number,
            },
            phaseBias: (pb as number[]).slice(),
            hysteresis: a.hysteresis as number,
          };
        }
      }
      if (fixed && adaptive && (ip.mode === "fixed" || ip.mode === "adaptive")) {
        out.intersections[inter.id] = { mode: ip.mode, fixed, adaptive };
      }
    }
  }
  const c = p.coordination as Record<string, unknown> | undefined;
  if (c !== undefined) {
    if (typeof c !== "object" || c === null) err("coordination must be an object");
    else {
      if (typeof c.enabled !== "boolean") err("coordination.enabled must be boolean");
      inBounds("coordination.cycle", c.cycle, BOUNDS.coordCycle);
      const wins = c.windows;
      if (!Array.isArray(wins)) err("coordination.windows must be an array");
      else {
        if (wins.length > BOUNDS.maxWindows) err(`coordination.windows has more than ${BOUNDS.maxWindows} entries`);
        const outWins: CoordinationWindow[] = [];
        wins.forEach((wRaw: unknown, i: number) => {
          const w = wRaw as Record<string, unknown>;
          const path = `coordination.windows[${i}]`;
          if (typeof w !== "object" || w === null) return err(`${path} must be an object`);
          const inter = typeof w.intersection === "string" ? net.intersectionById.get(w.intersection) : undefined;
          if (!inter) return err(`${path}.intersection unknown`);
          if (!Number.isInteger(w.phase) || (w.phase as number) < 0 || (w.phase as number) >= inter.phases.length) {
            return err(`${path}.phase must be a phase index of ${inter.id} (0..${inter.phases.length - 1})`);
          }
          if (!isNum(c.cycle)) return;
          if (!isNum(w.offset) || w.offset < 0 || w.offset >= c.cycle) err(`${path}.offset must be in [0, cycle)`);
          if (!isNum(w.length) || w.length <= 0 || w.length > c.cycle) err(`${path}.length must be in (0, cycle]`);
          inBounds(`${path}.bonus`, w.bonus, BOUNDS.windowBonus);
          if (out.intersections[inter.id]?.mode === "fixed") warnings.push(`${path} targets fixed-mode ${inter.id}; windows only affect adaptive intersections`);
          outWins.push({ intersection: inter.id, phase: w.phase as number, offset: w.offset as number, length: w.length as number, bonus: w.bonus as number });
        });
        if (typeof c.enabled === "boolean" && isNum(c.cycle)) out.coordination = { enabled: c.enabled, cycle: c.cycle, windows: outWins };
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, policy: out };
}

/** Phase requested by a fixed-time plan at time t (requests next phase once its own green has elapsed). */
export function fixedPhaseAt(plan: FixedPlan, t: number): number {
  const n = plan.splits.length;
  const eff = plan.cycle - n * CLEARANCE;
  const tc = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const g = plan.splits[i] * eff;
    if (tc < start + g) return i;
    if (tc < start + g + CLEARANCE) return (i + 1) % n;
    start += g + CLEARANCE;
  }
  return 0;
}

export function makePolicyController(policy: Policy, net: Network, name = "policy"): Controller {
  const ips = net.intersections.map((i) => policy.intersections[i.id]);
  const windows = net.intersections.map((i) =>
    policy.coordination.enabled ? policy.coordination.windows.filter((w) => w.intersection === i.id) : [],
  );
  const coordCycle = policy.coordination.cycle;
  return {
    name,
    decide(obs: Observation): number[] {
      const out: number[] = [];
      for (let ii = 0; ii < ips.length; ii++) {
        const ip = ips[ii];
        const s = obs.signals[ii];
        if (ip.mode === "fixed") {
          out.push(fixedPhaseAt(ip.fixed, obs.t));
          continue;
        }
        const a = ip.adaptive;
        if (s.state !== 0) {
          out.push(s.nextPhase);
          continue;
        }
        const tc = ((obs.t % coordCycle) + coordCycle) % coordCycle;
        const scores = obs.phases[ii].map((po, p) => {
          const pressure = po.queue * a.weights.queue + po.approaching * a.weights.approaching + po.oldestWait * a.weights.oldestWait;
          let sc = pressure * (1 - a.weights.downstream * po.downstreamOcc) + a.phaseBias[p];
          for (const w of windows[ii]) {
            if (w.phase !== p) continue;
            const rel = (((tc - w.offset) % coordCycle) + coordCycle) % coordCycle;
            if (rel < w.length) sc += w.bonus;
          }
          return sc;
        });
        const cur = s.phase;
        let best = -1;
        for (let p = 0; p < scores.length; p++) {
          if (p === cur) continue;
          if (best < 0 || scores[p] > scores[best]) best = p;
        }
        let req = cur;
        if (best >= 0 && s.greenElapsed >= a.minHold) {
          const competing = obs.phases[ii][best].queue + obs.phases[ii][best].approaching > 0;
          if (s.greenElapsed >= a.maxGreen[cur] && competing) req = best;
          else if (scores[best] > scores[cur] + a.hysteresis) req = best;
        }
        out.push(req);
      }
      return out;
    },
  };
}

export function clonePolicy(p: Policy): Policy {
  return JSON.parse(JSON.stringify(p)) as Policy;
}
