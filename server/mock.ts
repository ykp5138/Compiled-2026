// Development-only proposal generator used when Luminal credentials are unavailable.
// Output is tagged provider "mock" in every record and the UI labels it as such.
import { clonePolicy, mulberry32, type Policy } from "../sim";

export function mockPropose(role: string, seed: number, ctx: unknown): string {
  const { championPolicy, championId } = ctx as { championPolicy: Policy; championId: string };
  const rng = mulberry32(seed);
  const p = clonePolicy(championPolicy);
  const jitter = (x: number, rel: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, +(x * (1 + (rng() * 2 - 1) * rel)).toFixed(3)));
  let name = "";
  let explanation = "";
  for (const ip of Object.values(p.intersections)) {
    ip.mode = "adaptive";
  }
  if (role === "corridor") {
    const cycle = 60 + Math.round(rng() * 6) * 5;
    const bonus = +(2 + rng() * 6).toFixed(1);
    p.coordination = {
      enabled: true,
      cycle,
      windows: [
        { intersection: "C_PUG", phase: 0, offset: 0, length: 20, bonus },
        { intersection: "C_ALL", phase: 0, offset: 14, length: 20, bonus },
        { intersection: "C_ATH", phase: 0, offset: 50 % cycle, length: 20, bonus },
        { intersection: "B_ATH", phase: 0, offset: 0, length: 20, bonus },
        { intersection: "B_ALL", phase: 0, offset: 36, length: 20, bonus },
        { intersection: "B_PUG", phase: 0, offset: 50 % cycle, length: 20, bonus },
      ],
    };
    name = `Mock progression c${cycle} b${bonus}`;
    explanation = `Enabled coordination windows on both avenues, cycle ${cycle} s, bonus ${bonus}.`;
  } else if (role === "queue") {
    for (const ip of Object.values(p.intersections)) {
      ip.adaptive.weights.queue = jitter(ip.adaptive.weights.queue, 0.3, 0, 5);
      ip.adaptive.weights.approaching = jitter(ip.adaptive.weights.approaching, 0.4, 0, 5);
      ip.adaptive.weights.downstream = jitter(ip.adaptive.weights.downstream, 0.3, 0, 1);
      ip.adaptive.hysteresis = jitter(Math.max(0.5, ip.adaptive.hysteresis), 0.5, 0, 20);
    }
    name = "Mock weight perturbation";
    explanation = "Randomly perturbed queue/approaching/downstream weights and hysteresis by up to ±40%.";
  } else {
    for (const ip of Object.values(p.intersections)) {
      ip.adaptive.weights.oldestWait = jitter(Math.max(0.02, ip.adaptive.weights.oldestWait), 0.6, 0, 1);
      ip.adaptive.maxGreen = ip.adaptive.maxGreen.map((g) => Math.max(ip.adaptive.minHold, Math.round(jitter(g, 0.25, 10, 60))));
    }
    name = "Mock tail-wait perturbation";
    explanation = "Randomly perturbed oldest-wait weight and per-phase max greens.";
  }
  return JSON.stringify({
    name,
    parentId: championId,
    hypothesis: "Development provider: random perturbation for pipeline testing (not a model-generated hypothesis).",
    explanation,
    policy: p,
  });
}
