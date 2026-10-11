// Benchmark evaluation, paired comparisons and the predefined selection rule.
import type { Network } from "./network";
import { makePolicyController, type Policy } from "./policy";
import type { Scenario } from "./scenarios";
import { runEpisode, type EpisodeMetrics } from "./simulator";

export interface Aggregate {
  scenarios: number;
  /** Mean of per-scenario primary scores (stopped s per scheduled vehicle). */
  score: number;
  scoreSd: number;
  completionFraction: number;
  p95Wait: number;
  maxWait: number;
  sideP95Wait: number;
  meanTravelTimeCompleted: number;
  externalBacklog: number;
  inNetwork: number;
  totalSpillbackSec: number;
}

export interface SuiteEval {
  suite: string;
  perScenario: EpisodeMetrics[];
  aggregate: Aggregate;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function aggregate(per: EpisodeMetrics[]): Aggregate {
  return {
    scenarios: per.length,
    score: mean(per.map((m) => m.score)),
    scoreSd: sd(per.map((m) => m.score)),
    completionFraction: mean(per.map((m) => m.completionFraction)),
    p95Wait: mean(per.map((m) => m.p95Wait)),
    maxWait: Math.max(0, ...per.map((m) => m.maxWait)),
    sideP95Wait: mean(per.map((m) => m.sideP95Wait)),
    meanTravelTimeCompleted: mean(per.map((m) => m.meanTravelTimeCompleted)),
    externalBacklog: per.reduce((a, m) => a + m.externalBacklog, 0),
    inNetwork: per.reduce((a, m) => a + m.inNetwork, 0),
    totalSpillbackSec: mean(per.map((m) => m.totalSpillbackSec)),
  };
}

export function evaluatePolicy(net: Network, policy: Policy, scenarios: Scenario[], suite = "custom"): SuiteEval {
  const per = scenarios.map((sc) => runEpisode(net, sc, makePolicyController(policy, net)).metrics);
  return { suite, perScenario: per, aggregate: aggregate(per) };
}

/** 100 × (baseline − candidate) / baseline. Returns null when the baseline is zero and the candidate is not. */
export function relImprovement(baseline: number, candidate: number): number | null {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (100 * (baseline - candidate)) / baseline;
}

export interface PairedComparison {
  relImprovement: number | null;
  perScenario: { scenarioId: string; baseline: number; candidate: number; rel: number | null }[];
  wins: number;
  losses: number;
  ties: number;
  meanRel: number;
  sdRel: number;
  minRel: number;
  maxRel: number;
}

export function compare(candidate: SuiteEval, baseline: SuiteEval): PairedComparison {
  const byId = new Map(baseline.perScenario.map((m) => [m.scenarioId, m]));
  const perScenario = candidate.perScenario.map((c) => {
    const b = byId.get(c.scenarioId);
    if (!b) throw new Error(`Unpaired scenario ${c.scenarioId}`);
    return { scenarioId: c.scenarioId, baseline: b.score, candidate: c.score, rel: relImprovement(b.score, c.score) };
  });
  const rels = perScenario.map((p) => p.rel).filter((r): r is number => r !== null);
  const eps = 1e-9;
  return {
    relImprovement: relImprovement(baseline.aggregate.score, candidate.aggregate.score),
    perScenario,
    wins: perScenario.filter((p) => p.candidate < p.baseline - eps).length,
    losses: perScenario.filter((p) => p.candidate > p.baseline + eps).length,
    ties: perScenario.filter((p) => Math.abs(p.candidate - p.baseline) <= eps).length,
    meanRel: mean(rels),
    sdRel: sd(rels),
    minRel: rels.length ? Math.min(...rels) : 0,
    maxRel: rels.length ? Math.max(...rels) : 0,
  };
}

export const SELECTION_RULE = {
  minRelImprovementPct: 1.0,
  minWinFraction: 0.5,
  maxCompletionDrop: 0.005,
  sideP95Factor: 1.1,
  sideP95SlackSec: 2,
  p95Factor: 1.1,
  p95SlackSec: 2,
};

export const SELECTION_RULE_TEXT = [
  "Candidate must be a valid policy.",
  "Screen: mean training score must beat the champion's training score.",
  `Development score must improve on the champion by at least ${SELECTION_RULE.minRelImprovementPct}%.`,
  `Must win (lower score) on at least ${SELECTION_RULE.minWinFraction * 100}% of paired development scenarios.`,
  `Mean completion fraction may not drop by more than ${SELECTION_RULE.maxCompletionDrop * 100} percentage points.`,
  `Side-street (Allen/Pugh origin) P95 wait may not exceed champion × ${SELECTION_RULE.sideP95Factor} + ${SELECTION_RULE.sideP95SlackSec} s.`,
  `Overall P95 wait may not exceed champion × ${SELECTION_RULE.p95Factor} + ${SELECTION_RULE.p95SlackSec} s.`,
  "If several candidates pass in one round, the lowest development score becomes champion.",
];

export interface SelectionDecision {
  accept: boolean;
  reasons: string[];
  comparison: PairedComparison;
}

export function applySelectionRule(candidateDev: SuiteEval, championDev: SuiteEval): SelectionDecision {
  const r = SELECTION_RULE;
  const cmp = compare(candidateDev, championDev);
  const c = candidateDev.aggregate;
  const ch = championDev.aggregate;
  const failures: string[] = [];
  const rel = cmp.relImprovement ?? -Infinity;
  if (rel < r.minRelImprovementPct) failures.push(`dev improvement ${rel.toFixed(2)}% < ${r.minRelImprovementPct}%`);
  if (cmp.wins < r.minWinFraction * cmp.perScenario.length) failures.push(`won only ${cmp.wins}/${cmp.perScenario.length} dev scenarios`);
  if (c.completionFraction < ch.completionFraction - r.maxCompletionDrop) {
    failures.push(`completion ${(c.completionFraction * 100).toFixed(1)}% vs champion ${(ch.completionFraction * 100).toFixed(1)}%`);
  }
  if (c.sideP95Wait > ch.sideP95Wait * r.sideP95Factor + r.sideP95SlackSec) {
    failures.push(`side-street P95 wait ${c.sideP95Wait.toFixed(0)} s vs champion ${ch.sideP95Wait.toFixed(0)} s`);
  }
  if (c.p95Wait > ch.p95Wait * r.p95Factor + r.p95SlackSec) {
    failures.push(`P95 wait ${c.p95Wait.toFixed(0)} s vs champion ${ch.p95Wait.toFixed(0)} s`);
  }
  if (failures.length > 0) return { accept: false, reasons: failures, comparison: cmp };
  return {
    accept: true,
    reasons: [`dev improvement ${rel.toFixed(2)}%, won ${cmp.wins}/${cmp.perScenario.length}, guardrails passed`],
    comparison: cmp,
  };
}

/** Per-intersection bottleneck summary from a training evaluation (for agent context). */
export function bottleneckSummary(net: Network, ev: SuiteEval) {
  const rows = new Map<string, { link: string; street: string; dir: string; intersection: string; vehicles: number; stoppedVehSec: number; spillbackSec: number; blockedSec: number }>();
  for (const m of ev.perScenario) {
    for (const a of m.approaches) {
      const r = rows.get(a.link) ?? { link: a.link, street: a.street, dir: a.dir, intersection: a.intersection, vehicles: 0, stoppedVehSec: 0, spillbackSec: 0, blockedSec: 0 };
      r.vehicles += a.vehicles;
      r.stoppedVehSec += a.stoppedVehSec;
      r.spillbackSec += a.spillbackSec;
      r.blockedSec += a.blockedSec;
      rows.set(a.link, r);
    }
  }
  const n = Math.max(1, ev.perScenario.length);
  return net.intersections.map((inter) => ({
    intersection: inter.id,
    name: inter.name,
    approaches: [...rows.values()]
      .filter((r) => r.intersection === inter.id)
      .map((r) => ({
        approach: `${r.street} ${r.dir}`,
        link: r.link,
        meanWaitSec: +(r.vehicles ? r.stoppedVehSec / r.vehicles : 0).toFixed(1),
        stoppedVehSecPerEpisode: Math.round(r.stoppedVehSec / n),
        spillbackSecPerEpisode: Math.round(r.spillbackSec / n),
        blockedByDownstreamSecPerEpisode: Math.round(r.blockedSec / n),
      })),
  }));
}
