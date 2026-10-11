// Agent roles, prompt construction and response parsing.
// Agents only ever see TRAINING-suite metrics plus pass/fail outcomes of the development check.
import { CLEARANCE, POLICY_SCHEMA_DOC, SIM, type Network, type Policy } from "../sim";
import type { ChatMessage } from "./providers";

export type RoleId = "corridor" | "queue" | "robustness";

export interface RoleDef {
  id: RoleId;
  label: string;
  focus: string;
  temperature: number;
}

export const ROLES: RoleDef[] = [
  {
    id: "corridor",
    label: "Corridor Coordinator",
    focus:
      "green splits, offsets and coordinated progression along the main one-way arterials described in NETWORK (platoons travelling signal to signal). Your levers: coordination windows (cycle, offsets, lengths, bonuses), fixed-time plans (cycle, splits, offsets) and each intersection's mode. Leave queue weights to the Queue Optimizer.",
    temperature: 0.7,
  },
  {
    id: "queue",
    label: "Queue Optimizer",
    focus:
      "queue-responsive service, downstream (receiving-link) capacity and avoiding spillback. Your levers: adaptive weights (queue, approaching, downstream), minHold and hysteresis. Leave coordination windows to the Corridor Coordinator.",
    temperature: 0.7,
  },
  {
    id: "robustness",
    label: "Robustness Optimizer",
    focus:
      "side-street starvation (the minor approaches named in NETWORK), tail waiting times (P95/max) and robustness to changing or bursty demand. Your levers: per-phase maxGreen, the oldestWait weight and phaseBias. Avoid gains that come from starving any approach.",
    temperature: 0.8,
  },
];

export type VariantId = "refine" | "explore";

export interface VariantDef {
  id: VariantId;
  label: string;
  instruction: string;
  temperatureDelta: number;
}

export const VARIANTS: VariantDef[] = [
  {
    id: "refine",
    label: "refine",
    instruction:
      "STRATEGY: REFINE. Make a careful, incremental improvement to the current champion within your levers (a few targeted parameter changes at the intersections where the bottleneck data shows the most stopped time). Build on what has already worked.",
    temperatureDelta: -0.2,
  },
  {
    id: "explore",
    label: "explore",
    instruction:
      "STRATEGY: EXPLORE. Try a bolder, structurally different idea within your levers than the champion and recent candidates use (for example a different mode, a different coordination pattern, or a substantially different weighting). Do not just nudge numbers; test a new hypothesis.",
    temperatureDelta: 0.15,
  },
];

export interface AgentDef {
  /** e.g. "corridor-refine" */
  id: string;
  role: RoleDef;
  variant: VariantDef;
  label: string;
}

export function agentDefs(variantsPerRole: number): AgentDef[] {
  const vs = VARIANTS.slice(0, Math.max(1, Math.min(VARIANTS.length, variantsPerRole)));
  return ROLES.flatMap((role) =>
    vs.map((variant) => ({
      id: vs.length > 1 ? `${role.id}-${variant.id}` : role.id,
      role,
      variant,
      label: vs.length > 1 ? `${role.label} · ${variant.label}` : role.label,
    })),
  );
}

export interface CandidateSummaryForAgents {
  id: string;
  round: number;
  role: string;
  name: string;
  hypothesis: string;
  status: string;
  trainScore: number | null;
  trainVsChampionPct: number | null;
  outcome: string;
}

export interface AgentContext {
  round: number;
  championId: string;
  championLabel: string;
  championPolicy: Policy;
  championTrain: {
    score: number;
    completionFraction: number;
    p95Wait: number;
    sideP95Wait: number;
    perScenario: { scenario: string; type: string; score: number; p95Wait: number; sideP95Wait: number; completion: number; backlog: number }[];
  };
  baselines: { id: string; label: string; trainScore: number }[];
  recent: CandidateSummaryForAgents[];
  bottlenecks: unknown;
  lessons: string[];
  knownPolicyIds: string[];
}

export function describeNetwork(net: Network): string {
  const lines: string[] = [];
  if (net.raw.description?.length) lines.push(...net.raw.description);
  else {
    lines.push("Simplified downtown State College network (synthetic traffic). College Ave is one-way WESTBOUND; Beaver Ave one-way EASTBOUND (south of College).");
    lines.push("Cross streets west to east: Atherton St (two-way, 2 lanes each way), Allen St and Pugh St (two-way, 1 lane each way, ending at College Ave). Main arterials: College and Beaver (corridors C_PUG -> C_ALL -> C_ATH and B_ATH -> B_ALL -> B_PUG). Minor approaches: Allen and Pugh.");
  }
  lines.push(`Intersection IDs (${net.intersections.length}): ${net.intersections.map((i) => i.id).join(", ")}.`);
  for (const inter of net.intersections) {
    lines.push(`- ${inter.id} (${inter.name}):`);
    inter.phases.forEach((p, pi) => {
      const ms = p.movements.map((mi) => {
        const m = net.movements[mi];
        const f = net.links[m.from];
        const t = net.links[m.to];
        return `${f.street} ${f.dir} ${m.turn === "T" ? "through" : m.turn === "L" ? "left" : "right"} -> ${t.street} ${t.dir}`;
      });
      lines.push(`    phase ${pi} "${p.name}": ${ms.join("; ")}`);
    });
  }
  lines.push("Link lengths / free-flow travel times between signals:");
  for (const l of net.links) {
    if (l.kind !== "internal") continue;
    lines.push(`- ${l.id} ${l.street} ${l.dir} ${l.from}->${l.to}: ${l.length.toFixed(0)} m, ${l.lanes} lane(s), storage ${l.storagePerLane * l.lanes} veh, ~${((l.length + 2 * net.raw.intersectionInset) / l.speed).toFixed(1)} s`);
  }
  lines.push(`Signals: every switch costs ${CLEARANCE} s clearance (yellow ${SIM.yellow} s + all-red ${SIM.allRed} s). Stopped queues lose ${SIM.startupLostTime} s at the start of green. Saturation headway ${SIM.satHeadway} s per lane.`);
  return lines.join("\n");
}

export function buildMessages(agent: AgentDef, net: Network, ctx: AgentContext, teamSize: number): ChatMessage[] {
  const role = agent.role;
  const system = [
    `You are the ${role.label} (${agent.variant.label} variant), one of ${teamSize} AI agents working in parallel to improve traffic-signal control policies for a simplified, SYNTHETIC traffic simulation of ${net.raw.name}.`,
    `Your focus: ${role.focus}`,
    agent.variant.instruction,
    "Each round, every agent (three roles, each with a refine and an explore variant when the team has six members) proposes one competing policy. An ordinary program validates it, simulates it on fixed training scenarios, and checks promising ones on a separate development suite with a predefined selection rule. Unseen held-out tests are run only at the very end.",
    "Primary score (lower is better): total stopped vehicle-seconds (inside the network AND in external entry queues) divided by scheduled vehicles. Gains that sacrifice trip completion, side-street P95 wait or overall P95 wait are rejected.",
    "Controllers only see present detector aggregates (queues, approaching vehicles, oldest wait, downstream occupancy, time since green). They never see future arrivals.",
    "Make a focused, testable change with a clear hypothesis. Learn from previous results: do not repeat failed ideas.",
    "Keep your private reasoning focused and brief; the simulator does the detailed evaluation. Spend your effort on one good idea, then output the JSON.",
    "Respond with ONLY one JSON object, no markdown, no commentary, in exactly this shape:",
    `{"name": "<short candidate name>", "parentId": "<policy id you modified, normally the champion>", "hypothesis": "<one or two sentences>", "explanation": "<concise list of changed parameters and expected effects>", "policy": { <complete policy JSON> }}`,
    "The policy must be COMPLETE (all six intersections, both fixed and adaptive blocks, and coordination) and must satisfy the schema bounds below.",
    "",
    POLICY_SCHEMA_DOC,
  ].join("\n");

  const user = [
    `ROUND ${ctx.round}`,
    "",
    "NETWORK",
    describeNetwork(net),
    "",
    `CURRENT CHAMPION: ${ctx.championId} (${ctx.championLabel})`,
    `Training: score ${ctx.championTrain.score.toFixed(2)} s/veh, completion ${(ctx.championTrain.completionFraction * 100).toFixed(1)}%, P95 wait ${ctx.championTrain.p95Wait.toFixed(0)} s, side-street P95 ${ctx.championTrain.sideP95Wait.toFixed(0)} s`,
    "Per training scenario:",
    ...ctx.championTrain.perScenario.map(
      (s) => `- ${s.scenario} [${s.type}]: score ${s.score.toFixed(2)}, P95 ${s.p95Wait.toFixed(0)} s, side P95 ${s.sideP95Wait.toFixed(0)} s, completion ${(s.completion * 100).toFixed(1)}%, backlog ${s.backlog}`,
    ),
    "",
    "Champion policy JSON:",
    JSON.stringify(ctx.championPolicy),
    "",
    "BASELINES (training score): " + ctx.baselines.map((b) => `${b.label} ${b.trainScore.toFixed(2)}`).join("; "),
    "",
    "PER-INTERSECTION BOTTLENECKS for the champion (training suite, per-episode averages):",
    JSON.stringify(ctx.bottlenecks),
    "",
    "RECENT CANDIDATES (all agents):",
    ctx.recent.length === 0
      ? "(none yet)"
      : ctx.recent
          .map(
            (c) =>
              `- [r${c.round} ${c.role}] ${c.id} "${c.name}": ${c.status}; train ${c.trainScore === null ? "n/a" : c.trainScore.toFixed(2)}${c.trainVsChampionPct === null ? "" : ` (${c.trainVsChampionPct >= 0 ? "+" : ""}${c.trainVsChampionPct.toFixed(1)}% vs champion at the time)`}; ${c.outcome}. Hypothesis: ${c.hypothesis}`,
          )
          .join("\n"),
    "",
    "LESSONS SO FAR:",
    ctx.lessons.length ? ctx.lessons.map((l) => `- ${l}`).join("\n") : "(none yet)",
    "",
    `Known policy IDs: ${ctx.knownPolicyIds.join(", ")}`,
    "Return the JSON object now.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface ParsedProposal {
  name: string;
  parentId: string;
  hypothesis: string;
  explanation: string;
  policy: unknown;
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in response");
  return JSON.parse(t.slice(start, end + 1));
}

export function parseProposal(text: string): { ok: true; value: ParsedProposal } | { ok: false; errors: string[] } {
  if (!text.trim()) return { ok: false, errors: ["empty response"] };
  let obj: unknown;
  try {
    obj = extractJson(text);
  } catch (e) {
    return { ok: false, errors: [`malformed JSON: ${(e as Error).message}`] };
  }
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: ["response is not a JSON object"] };
  const o = obj as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of ["name", "hypothesis", "explanation"]) if (typeof o[k] !== "string" || !(o[k] as string).trim()) errors.push(`missing string field "${k}"`);
  if (typeof o.policy !== "object" || o.policy === null) errors.push('missing object field "policy"');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: (o.name as string).slice(0, 80),
      parentId: typeof o.parentId === "string" ? o.parentId : "",
      hypothesis: (o.hypothesis as string).slice(0, 600),
      explanation: (o.explanation as string).slice(0, 1200),
      policy: o.policy,
    },
  };
}

export function repairMessages(original: ChatMessage[], previous: string, errors: string[]): ChatMessage[] {
  return [
    ...original,
    { role: "assistant", content: previous.slice(0, 12000) },
    {
      role: "user",
      content: `Your previous response could not be used:\n${errors.slice(0, 15).map((e) => `- ${e}`).join("\n")}\nReply again with ONLY the corrected, complete JSON object (name, parentId, hypothesis, explanation, policy).`,
    },
  ];
}
