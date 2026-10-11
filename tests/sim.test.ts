import { describe, expect, it } from "vitest";
import {
  buildHeuristicPolicy,
  buildNetwork,
  CLEARANCE,
  generateScenario,
  getNetwork,
  makePolicyController,
  movementsConflict,
  recordReplay,
  runEpisode,
  SIM,
  validatePolicy,
  type Controller,
  type Policy,
} from "../sim";

const net = getNetwork();
const scenario = generateScenario(net, "train", "bursty", 4242, { horizon: 300, drain: 120, dt: 0.5 });
const heuristic = buildHeuristicPolicy(net);

function fixedPolicy(): Policy {
  const p = JSON.parse(JSON.stringify(heuristic)) as Policy;
  for (const id of Object.keys(p.intersections)) {
    p.intersections[id].mode = "fixed";
    p.intersections[id].fixed = { cycle: 70, splits: [0.6, 0.4], offset: 0 };
  }
  return p;
}

describe("determinism", () => {
  it("regenerates identical demand from the same seed", () => {
    const a = generateScenario(net, "train", "shift", 7, { horizon: 300, drain: 60, dt: 0.5 });
    const b = generateScenario(net, "train", "shift", 7, { horizon: 300, drain: 60, dt: 0.5 });
    expect(a.checksum).toBe(b.checksum);
    expect(a.arrivals).toEqual(b.arrivals);
  });
  it("produces identical metrics for repeated runs", () => {
    const r1 = runEpisode(net, scenario, makePolicyController(heuristic, net));
    const r2 = runEpisode(net, scenario, makePolicyController(heuristic, net));
    expect(r1.metrics).toEqual(r2.metrics);
  });
  it("different suites produce different demand", () => {
    const a = generateScenario(net, "train", "balanced", 1, { horizon: 300, drain: 60, dt: 0.5 });
    const b = generateScenario(net, "heldout", "balanced", 1, { horizon: 300, drain: 60, dt: 0.5 });
    expect(a.checksum).not.toBe(b.checksum);
  });
});

describe("safety and conservation", () => {
  for (const [name, policy] of [["heuristic", heuristic], ["fixed", fixedPolicy()]] as const) {
    it(`${name}: no red crossings, capacity or conservation violations`, () => {
      const r = runEpisode(net, scenario, makePolicyController(policy, net), { audit: true });
      expect(r.audit).toMatchObject({
        redCrossings: 0,
        conflictingGreens: 0,
        capacityViolations: 0,
        conservationErrors: 0,
        minGreenViolations: 0,
        clearanceViolations: 0,
      });
      const m = r.metrics;
      expect(m.completed + m.inNetwork + m.externalBacklog).toBe(m.scheduled);
    });
  }

  it("no phase contains conflicting movements", () => {
    for (const inter of net.intersections) {
      for (const p of inter.phases) {
        for (const a of p.movements) for (const b of p.movements) {
          if (a !== b) expect(movementsConflict(net, net.movements[a], net.movements[b])).toBe(false);
        }
      }
    }
  });

  it("rejects a network whose phase mixes conflicting movements", () => {
    const raw = JSON.parse(JSON.stringify(net.raw));
    const c = raw.intersections.find((i: { id: string }) => i.id === "C_ATH");
    c.phases[0].movements.push(c.phases[1].movements[0]);
    c.phases[1].movements.shift();
    expect(() => buildNetwork(raw)).toThrow(/Conflicting|two phases/);
  });

  it("controllers cannot bypass min green, clearance or anti-starvation", () => {
    // Adversarial controller: requests a different phase every step, then starves phase 1 forever.
    let flip = 0;
    const thrash: Controller = { name: "thrash", decide: (obs) => obs.signals.map(() => flip++ % 2) };
    const r1 = runEpisode(net, scenario, thrash, { audit: true });
    expect(r1.audit!.minGreenViolations).toBe(0);
    expect(r1.audit!.clearanceViolations).toBe(0);
    expect(r1.audit!.redCrossings).toBe(0);

    let maxRed = 0;
    const starve: Controller = {
      name: "starve",
      decide: (obs) => {
        for (const ps of obs.phases) if (ps[1].queue > 0) maxRed = Math.max(maxRed, ps[1].sinceGreen);
        return obs.signals.map(() => 0);
      },
    };
    const r2 = runEpisode(net, scenario, starve, { audit: true });
    expect(r2.metrics.completionFraction).toBeGreaterThan(0.5);
    // Side phases with queues are served within maxRedWait + max green + clearance.
    expect(maxRed).toBeLessThanOrEqual(SIM.maxRedWait + SIM.maxGreen + CLEARANCE + 1);
  });

  it("observations never expose future arrivals or scenario identity", () => {
    let keys: string[] = [];
    const spy: Controller = {
      name: "spy",
      decide: (obs) => {
        keys = Object.keys(obs);
        return obs.signals.map((s) => s.phase);
      },
    };
    runEpisode(net, scenario, spy);
    expect(keys.sort()).toEqual(["phases", "signals", "t"]);
  });
});

describe("policies", () => {
  it("accepts the baseline policies", () => {
    expect(validatePolicy(heuristic, net).ok).toBe(true);
    expect(validatePolicy(fixedPolicy(), net).ok).toBe(true);
  });
  it("rejects out-of-range values, unknown IDs and bad phase references", () => {
    const bad = JSON.parse(JSON.stringify(heuristic));
    bad.intersections.C_ATH.adaptive.minHold = 2;
    bad.intersections.NOPE = bad.intersections.C_ALL;
    bad.coordination = { enabled: true, cycle: 90, windows: [{ intersection: "C_ALL", phase: 5, offset: 0, length: 10, bonus: 5 }] };
    const v = validatePolicy(bad, net);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/minHold/);
    expect(v.errors.join("\n")).toMatch(/NOPE/);
    expect(v.errors.join("\n")).toMatch(/phase/);
  });
  it("rejects fixed plans whose greens violate simulator limits", () => {
    const p = fixedPolicy();
    (p.intersections.C_ALL.fixed as { splits: number[] }).splits = [0.95, 0.05];
    expect(validatePolicy(p, net).ok).toBe(false);
  });
  it("rejects non-object garbage", () => {
    expect(validatePolicy("hello", net).ok).toBe(false);
    expect(validatePolicy(null, net).ok).toBe(false);
  });
});

describe("replay", () => {
  it("recorded replay matches the benchmark run exactly", () => {
    const bench = runEpisode(net, scenario, makePolicyController(heuristic, net)).metrics;
    const rep = recordReplay(net, scenario, heuristic, "h", "Heuristic");
    expect(rep.final).toEqual(bench);
    const last = rep.frames[rep.frames.length - 1];
    expect(last.m[2]).toBe(bench.completed);
    expect(rep.frames.length).toBe(Math.round((scenario.horizon + scenario.drain) / rep.frameEvery) + 1);
  });
});

describe("Manhattan (East Village) network from Google Maps geometry", () => {
  const mh = getNetwork("manhattan-east-village");
  const sc = generateScenario(mh, "train", "bursty", 77, { horizon: 300, drain: 120, dt: 0.5 });
  it("builds with conflict-free phases and simulates safely", () => {
    expect(mh.intersections.length).toBe(24);
    const r = runEpisode(mh, sc, makePolicyController(buildHeuristicPolicy(mh), mh), { audit: true });
    expect(r.audit).toMatchObject({ redCrossings: 0, conflictingGreens: 0, capacityViolations: 0, conservationErrors: 0, minGreenViolations: 0, clearanceViolations: 0 });
    expect(r.metrics.completed + r.metrics.inNetwork + r.metrics.externalBacklog).toBe(r.metrics.scheduled);
  });
  it("validates policies against its own intersection IDs", () => {
    expect(validatePolicy(buildHeuristicPolicy(mh), mh).ok).toBe(true);
    expect(validatePolicy(buildHeuristicPolicy(net), mh).ok).toBe(false);
  });
});
