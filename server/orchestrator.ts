// The orchestrator is ordinary code: it collects concurrent agent proposals, validates them,
// evaluates them on identical scenarios, applies the predefined selection rule and feeds results back.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  aggregate,
  applySelectionRule,
  bottleneckSummary,
  calibrateFixedBaseline,
  calibrateHeuristicBaseline,
  compare,
  DEFAULT_DEMAND,
  FIXED_BASELINE_ID,
  generateSuite,
  getNetwork,
  hashString,
  HEURISTIC_BASELINE_ID,
  makePolicyController,
  manifestOf,
  recordReplay,
  relImprovement,
  runEpisode,
  SCENARIO_TYPES,
  SELECTION_RULE_TEXT,
  SIMULATOR_VERSION,
  validatePolicy,
  type Network,
  type Policy,
  type Replay,
  type Scenario,
  type ScenarioType,
} from "../sim";
import { agentDefs, buildMessages, parseProposal, repairMessages, type AgentContext, type AgentDef, type RoleId } from "./agents";
import { config } from "./config";
import { generateHeldOutSuite } from "./heldout";
import { createProvider, type AgentProvider } from "./providers";
import { mongo } from "./mongo";
import { listRuns, loadAllExperiments, loadExperiment, newRunId, runDir, saveExperiment } from "./store";
import type { BaselineRecord, CandidateRecord, Experiment, SuiteResult } from "./types";

export type AgentPhase = "idle" | "proposing" | "repairing" | "validating" | "testing" | "dev-check" | "accepted" | "rejected" | "invalid" | "error";

export interface AgentStatus {
  agentId: string;
  role: RoleId;
  variant: string;
  label: string;
  phase: AgentPhase;
  candidateId?: string;
  name?: string;
  hypothesis?: string;
  message?: string;
  updatedAt: string;
}

export interface ActivityEvent {
  at: string;
  role?: RoleId;
  agent?: string;
  text: string;
}

const TRAIN_TYPES: ScenarioType[] = ["balanced", "arterial", "side", "bursty", "shift", "balanced", "bursty", "shift"];
const DEV_TYPES: ScenarioType[] = ["balanced", "side", "bursty", "shift"];

export const SCORE_DEFINITION =
  "Primary score = total stopped vehicle-seconds (speed < 0.5 m/s inside the network, plus all time spent in external entry queues) ÷ total scheduled vehicles. Lower is better. Every controller gets the same 900 s demand horizon and 300 s drain; unfinished vehicles keep accumulating stopped time and are reported as residual backlog.";

const tick = () => new Promise<void>((r) => setImmediate(r));

export class Orchestrator extends EventEmitter {
  readonly net: Network = getNetwork();
  provider: AgentProvider = createProvider();
  exp: Experiment | null = null;
  private train: Scenario[] = [];
  private dev: Scenario[] = [];
  private heldOut: Scenario[] | null = null;
  busy: string | null = null;
  progress: { round: number; of: number } | null = null;
  /** True once rounds have been executed in this server process for the loaded experiment. */
  live = false;
  readonly team: AgentDef[] = agentDefs(config.experiment.variantsPerRole);
  agents: Record<string, AgentStatus> = Object.fromEntries(
    this.team.map((a) => [a.id, { agentId: a.id, role: a.role.id, variant: a.variant.id, label: a.label, phase: "idle", updatedAt: new Date().toISOString() }]),
  ) as Record<string, AgentStatus>;
  activity: ActivityEvent[] = [];
  private replayCache = new Map<string, Replay>();

  private log(text: string, agentId?: string) {
    const a = agentId ? this.agents[agentId] : undefined;
    const ev: ActivityEvent = { at: new Date().toISOString(), role: a?.role, agent: a ? agentId : undefined, text };
    this.activity.push(ev);
    if (this.activity.length > 200) this.activity.shift();
    this.emit("log", ev);
    this.emit("agents");
  }

  private setAgent(agentId: string, patch: Partial<AgentStatus>) {
    if (!this.agents[agentId]) return;
    this.agents[agentId] = { ...this.agents[agentId], ...patch, updatedAt: new Date().toISOString() };
    this.emit("agents");
  }

  private changed() {
    if (this.exp) {
      saveExperiment(this.exp);
      mongo.schedule(this.exp);
    }
    this.emit("state");
  }

  /** Reconcile local JSON runs with MongoDB (no-op without MONGODB_URI). */
  async syncStorage(): Promise<{ pulled: string[]; pushed: string[] }> {
    if (!mongo.enabled) return { pulled: [], pushed: [] };
    const res = await mongo.sync(loadAllExperiments(), (e) => saveExperiment(e, true));
    if (res.pulled.length) this.log(`Pulled ${res.pulled.length} run(s) from MongoDB: ${res.pulled.join(", ")}`);
    if (res.pushed.length) this.log(`Pushed ${res.pushed.length} local run(s) to MongoDB`);
    this.emit("state");
    return res;
  }

  private async evalSuite(policy: Policy, scenarios: Scenario[]): Promise<SuiteResult> {
    const per = [];
    for (const sc of scenarios) {
      per.push(runEpisode(this.net, sc, makePolicyController(policy, this.net)).metrics);
      await tick();
    }
    return { aggregate: aggregate(per), perScenario: per };
  }

  private regenerateSuites(exp: Experiment) {
    if (exp.simulatorVersion !== SIMULATOR_VERSION || JSON.stringify(exp.network) !== JSON.stringify(this.net.raw)) {
      throw new Error(`Run ${exp.runId} was recorded with a different simulator version or network file`);
    }
    const d = exp.demand;
    this.train = generateSuite(this.net, "train", exp.suiteSpecs.train, d);
    this.dev = generateSuite(this.net, "dev", exp.suiteSpecs.dev, d);
    const check = (got: Scenario[], want: { id: string; checksum: string }[]) =>
      got.length === want.length && got.every((s, i) => s.id === want[i].id && s.checksum === want[i].checksum);
    if (!check(this.train, exp.suites.train) || !check(this.dev, exp.suites.dev)) {
      throw new Error(`Scenario checksums for ${exp.runId} do not match this simulator/demand version`);
    }
    this.heldOut = null;
    if (exp.heldOut) {
      this.heldOut = generateHeldOutSuite(this.net, exp, { championId: exp.heldOut.championId, frozenAt: exp.heldOut.frozenAt });
    }
  }

  async init(): Promise<void> {
    mongo.onChange = () => this.emit("agents");
    if (mongo.enabled) {
      this.log(`Connecting to MongoDB (${mongo.status.host}, database "${mongo.status.database}")`);
      await this.syncStorage();
      if (mongo.status.lastError) this.log(`MongoDB unavailable, using local JSON only: ${mongo.status.lastError}`);
    }
    const runs = listRuns();
    for (const r of runs) {
      try {
        if (this.loadRun(r.runId)) return;
      } catch (e) {
        this.log(`Skipped run ${r.runId}: ${(e as Error).message}`);
      }
    }
    await this.createExperiment();
  }

  loadRun(runId: string): boolean {
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    const exp = loadExperiment(runId);
    if (!exp) return false;
    this.regenerateSuites(exp);
    this.exp = exp;
    this.live = false;
    this.replayCache.clear();
    for (const a of this.team) this.setAgent(a.id, { phase: "idle", candidateId: undefined, name: undefined, hypothesis: undefined, message: undefined });
    this.log(`Loaded recorded run ${runId}`);
    this.emit("state");
    return true;
  }

  async createExperiment(): Promise<void> {
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    this.busy = "Calibrating baselines on training scenarios";
    this.emit("state");
    try {
      const demand = { ...DEFAULT_DEMAND, horizon: config.experiment.horizon, drain: config.experiment.drain };
      const specs = {
        train: { ...config.experiment.train, types: TRAIN_TYPES },
        dev: { ...config.experiment.dev, types: DEV_TYPES },
        heldOut: { count: config.experiment.heldOutCount, types: SCENARIO_TYPES },
      };
      const train = generateSuite(this.net, "train", specs.train, demand);
      const dev = generateSuite(this.net, "dev", specs.dev, demand);
      this.log("Calibrating fixed-time baseline (Webster + grid search on training demand)");
      await tick();
      const fx = await calibrateFixedBaseline(this.net, train, tick);
      await tick();
      this.log("Calibrating queue-responsive heuristic baseline on training demand");
      await tick();
      const hx = await calibrateHeuristicBaseline(this.net, train, tick);
      const fixed: BaselineRecord = {
        id: FIXED_BASELINE_ID,
        label: "Fixed-time (calibrated)",
        policy: fx.policy,
        calibration: fx.log,
        train: await this.evalSuite(fx.policy, train),
        dev: await this.evalSuite(fx.policy, dev),
      };
      const heuristic: BaselineRecord = {
        id: HEURISTIC_BASELINE_ID,
        label: "Queue-responsive heuristic",
        policy: hx.policy,
        calibration: hx.log,
        train: await this.evalSuite(hx.policy, train),
        dev: await this.evalSuite(hx.policy, dev),
      };
      const start = heuristic.dev.aggregate.score <= fixed.dev.aggregate.score ? heuristic : fixed;
      const now = new Date().toISOString();
      const runId = newRunId();
      this.exp = {
        runId,
        createdAt: now,
        updatedAt: now,
        simulatorVersion: SIMULATOR_VERSION,
        network: this.net.raw,
        demand,
        suiteSpecs: specs,
        suites: { train: train.map(manifestOf), dev: dev.map(manifestOf) },
        selectionRule: SELECTION_RULE_TEXT,
        scoreDefinition: SCORE_DEFINITION,
        provider: this.provider.info(),
        baselines: { fixed, heuristic },
        championId: start.id,
        championHistory: [
          {
            round: 0,
            policyId: start.id,
            label: start.label,
            trainScore: start.train.aggregate.score,
            devScore: start.dev.aggregate.score,
            at: now,
            reason: "Starting champion: stronger baseline on the development suite",
          },
        ],
        candidates: [],
        rounds: [],
        lessons: [],
        heldOut: null,
        commands: [
          "npm run bench",
          `npm run optimize -- --run ${runId} --rounds ${config.experiment.rounds}`,
          `npm run final -- --run ${runId}`,
        ],
      };
      this.train = train;
      this.dev = dev;
      this.heldOut = null;
      this.live = true;
      this.replayCache.clear();
      for (const a of this.team) this.setAgent(a.id, { phase: "idle", candidateId: undefined, name: undefined, hypothesis: undefined, message: undefined });
      this.log(`Created experiment ${runId}. Fixed-time dev ${fixed.dev.aggregate.score.toFixed(2)} s/veh, heuristic dev ${heuristic.dev.aggregate.score.toFixed(2)} s/veh; starting champion: ${start.label}`);
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  policyById(id: string): { policy: Policy; label: string } | null {
    const exp = this.exp;
    if (!exp) return null;
    if (id === FIXED_BASELINE_ID) return { policy: exp.baselines.fixed.policy, label: exp.baselines.fixed.label };
    if (id === HEURISTIC_BASELINE_ID) return { policy: exp.baselines.heuristic.policy, label: exp.baselines.heuristic.label };
    const c = exp.candidates.find((x) => x.id === id);
    return c?.policy ? { policy: c.policy, label: c.name } : null;
  }

  private championRecord(): { id: string; label: string; policy: Policy; train: SuiteResult; dev: SuiteResult } {
    const exp = this.exp!;
    const id = exp.championId;
    if (id === FIXED_BASELINE_ID || id === HEURISTIC_BASELINE_ID) {
      const b = id === FIXED_BASELINE_ID ? exp.baselines.fixed : exp.baselines.heuristic;
      return { id, label: b.label, policy: b.policy, train: b.train, dev: b.dev };
    }
    const c = exp.candidates.find((x) => x.id === id)!;
    return { id, label: c.name, policy: c.policy!, train: c.train!, dev: c.dev! };
  }

  /** Agent context: training metrics, champion, recent outcomes and lessons. Never held-out data. */
  buildContext(round: number): AgentContext {
    const exp = this.exp!;
    const champ = this.championRecord();
    const manifests = new Map(exp.suites.train.map((m) => [m.id, m]));
    const recent = exp.candidates.slice(-9).map((c) => ({
      id: c.id,
      round: c.round,
      role: c.roleLabel,
      name: c.name,
      hypothesis: c.hypothesis,
      status: c.status,
      trainScore: c.train ? c.train.aggregate.score : null,
      trainVsChampionPct: c.trainVsChampionPct ?? null,
      outcome: c.decision.join("; "),
    }));
    return {
      round,
      championId: champ.id,
      championLabel: champ.label,
      championPolicy: champ.policy,
      championTrain: {
        score: champ.train.aggregate.score,
        completionFraction: champ.train.aggregate.completionFraction,
        p95Wait: champ.train.aggregate.p95Wait,
        sideP95Wait: champ.train.aggregate.sideP95Wait,
        perScenario: champ.train.perScenario.map((m) => ({
          scenario: m.scenarioId,
          type: manifests.get(m.scenarioId)?.type ?? "?",
          score: m.score,
          p95Wait: m.p95Wait,
          sideP95Wait: m.sideP95Wait,
          completion: m.completionFraction,
          backlog: m.externalBacklog + m.inNetwork,
        })),
      },
      baselines: [
        { id: FIXED_BASELINE_ID, label: exp.baselines.fixed.label, trainScore: exp.baselines.fixed.train.aggregate.score },
        { id: HEURISTIC_BASELINE_ID, label: exp.baselines.heuristic.label, trainScore: exp.baselines.heuristic.train.aggregate.score },
      ],
      recent,
      bottlenecks: bottleneckSummary(this.net, { suite: "train", ...champ.train }),
      lessons: exp.lessons.slice(-15),
      knownPolicyIds: [FIXED_BASELINE_ID, HEURISTIC_BASELINE_ID, ...exp.candidates.filter((c) => c.policy).map((c) => c.id)],
    };
  }

  private async propose(agent: AgentDef, round: number, ctx: AgentContext): Promise<CandidateRecord> {
    const exp = this.exp!;
    const role = agent.role;
    const aid = agent.id;
    const id = `r${round}-${agent.id}`;
    const info = this.provider.info();
    const rec: CandidateRecord = {
      id,
      round,
      role: role.id,
      agentId: agent.id,
      variant: agent.variant.id,
      roleLabel: agent.label,
      provider: info.kind,
      name: "(no proposal)",
      parentId: ctx.championId,
      claimedParentId: "",
      hypothesis: "",
      explanation: "",
      policy: null,
      status: "invalid",
      validationErrors: [],
      validationWarnings: [],
      repairAttempts: 0,
      calls: [],
      decision: [],
      createdAt: new Date().toISOString(),
    };
    this.setAgent(aid, { phase: "proposing", candidateId: id, name: undefined, hypothesis: undefined, message: `Calling ${info.label}` });
    this.log(`Requesting proposal from ${info.label}`, aid);
    const messages = buildMessages(agent, this.net, ctx, this.team.length);
    const mockOpts = { mockRole: role.id, mockSeed: hashString(`${exp.runId}:${round}:${agent.id}`), mockContext: { championPolicy: ctx.championPolicy, championId: ctx.championId } };
    const first = await this.provider.complete(messages, { temperature: Math.max(0.1, role.temperature + agent.variant.temperatureDelta), ...mockOpts });
    rec.calls.push(first.call);
    if (first.call.error) {
      rec.status = "provider-error";
      rec.decision = [`provider error: ${first.call.error}`];
      this.setAgent(aid, { phase: "error", message: first.call.error });
      this.log(`Provider error: ${first.call.error}`, aid);
      return rec;
    }
    this.setAgent(aid, { phase: "validating", message: `Response in ${(first.call.latencyMs / 1000).toFixed(1)} s; validating` });
    let content = first.content;
    let parsed = parseProposal(content);
    let validation = parsed.ok ? validatePolicy(parsed.value.policy, this.net) : null;
    let errors = parsed.ok ? validation!.errors : parsed.errors;
    if (errors.length > 0) {
      rec.validationErrors.push(...errors.map((e) => `attempt 1: ${e}`));
      rec.repairAttempts = 1;
      this.setAgent(aid, { phase: "repairing", message: `Invalid (${errors[0]}); requesting one repair` });
      this.log(`Invalid proposal (${errors.length} issue(s): ${errors[0]}); bounded repair retry`, aid);
      const second = await this.provider.complete(repairMessages(messages, content, errors), { temperature: Math.max(0.2, role.temperature + agent.variant.temperatureDelta - 0.3), ...mockOpts });
      rec.calls.push(second.call);
      if (second.call.error) {
        rec.status = "provider-error";
        rec.decision = [`provider error during repair: ${second.call.error}`];
        this.setAgent(aid, { phase: "error", message: second.call.error });
        return rec;
      }
      content = second.content;
      parsed = parseProposal(content);
      validation = parsed.ok ? validatePolicy(parsed.value.policy, this.net) : null;
      errors = parsed.ok ? validation!.errors : parsed.errors;
      if (errors.length > 0) rec.validationErrors.push(...errors.map((e) => `attempt 2: ${e}`));
    }
    if (parsed.ok) {
      rec.name = parsed.value.name;
      rec.hypothesis = parsed.value.hypothesis;
      rec.explanation = parsed.value.explanation;
      rec.claimedParentId = parsed.value.parentId;
      const known = ctx.knownPolicyIds.includes(parsed.value.parentId);
      rec.parentId = known ? parsed.value.parentId : ctx.championId;
      if (!known) rec.validationWarnings.push(`claimed parent "${parsed.value.parentId}" unknown; recorded parent = champion ${ctx.championId}`);
    }
    if (!parsed.ok || !validation?.ok) {
      rec.status = "invalid";
      rec.decision = [`invalid after ${rec.repairAttempts} repair attempt(s): ${errors[0] ?? "unknown"}`];
      this.setAgent(aid, { phase: "invalid", name: rec.name, hypothesis: rec.hypothesis, message: errors[0] });
      this.log(`Rejected as invalid: ${errors[0]}`, aid);
      return rec;
    }
    rec.policy = validation.policy!;
    rec.validationWarnings.push(...validation.warnings);
    rec.status = "screened-out"; // provisional until tested
    this.setAgent(aid, { phase: "validating", name: rec.name, hypothesis: rec.hypothesis, message: "Valid policy; queued for simulation" });
    this.log(`Proposed "${rec.name}"`, aid);
    return rec;
  }

  async runRounds(n: number): Promise<void> {
    if (!this.exp) throw new Error("No experiment loaded");
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    if (this.exp.heldOut) throw new Error("This experiment is frozen and has been tested on held-out data. Start a new experiment to continue optimizing.");
    this.exp.provider = this.provider.info();
    this.busy = "Running improvement rounds";
    this.live = true;
    const startRound = this.exp.rounds.length + 1;
    this.progress = { round: startRound, of: startRound + n - 1 };
    this.changed();
    try {
      for (let round = startRound; round < startRound + n; round++) {
        this.progress = { round, of: startRound + n - 1 };
        await this.runRound(round);
      }
    } finally {
      this.busy = null;
      this.progress = null;
      this.changed();
    }
  }

  private async runRound(round: number): Promise<void> {
    const exp = this.exp!;
    const champ = this.championRecord();
    const roundRec = { round, startedAt: new Date().toISOString(), candidateIds: [] as string[], championBefore: champ.id };
    exp.rounds.push(roundRec);
    this.log(`Round ${round} started; champion ${champ.label} (train ${champ.train.aggregate.score.toFixed(2)}, dev ${champ.dev.aggregate.score.toFixed(2)} s/veh)`);
    this.changed();

    // 1. Concurrent proposals.
    const ctx = this.buildContext(round);
    const cands = await Promise.all(this.team.map((agent) => this.propose(agent, round, ctx)));
    exp.candidates.push(...cands);
    roundRec.candidateIds = cands.map((c) => c.id);
    this.changed();

    // 2-3. Evaluate valid candidates on the same training scenarios.
    const champTrain = champ.train.aggregate.score;
    for (const c of cands) {
      if (!c.policy) continue;
      this.setAgent(c.agentId ?? c.role, { phase: "testing", message: `Simulating ${this.train.length} training episodes` });
      c.train = await this.evalSuite(c.policy, this.train);
      c.trainVsChampionPct = relImprovement(champTrain, c.train.aggregate.score);
      this.log(`"${c.name}" training ${c.train.aggregate.score.toFixed(2)} s/veh (${(c.trainVsChampionPct ?? 0).toFixed(1)}% vs champion)`, c.agentId ?? c.role);
      this.changed();
    }

    // 4. Promising candidates go to the fixed development suite; 5. selection rule.
    const passed: CandidateRecord[] = [];
    for (const c of cands) {
      if (!c.policy || !c.train) continue;
      if (c.train.aggregate.score >= champTrain) {
        c.status = "screened-out";
        c.decision = [`training ${c.train.aggregate.score.toFixed(2)} did not beat champion ${champTrain.toFixed(2)}`];
        this.setAgent(c.agentId ?? c.role, { phase: "rejected", message: c.decision[0] });
        continue;
      }
      this.setAgent(c.agentId ?? c.role, { phase: "dev-check", message: `Training improved ${(c.trainVsChampionPct ?? 0).toFixed(1)}%; checking development suite` });
      c.dev = await this.evalSuite(c.policy, this.dev);
      const decision = applySelectionRule({ suite: "dev", ...c.dev }, { suite: "dev", ...champ.dev });
      const cmp = decision.comparison;
      c.devComparison = { relImprovement: cmp.relImprovement, wins: cmp.wins, losses: cmp.losses, ties: cmp.ties, meanRel: cmp.meanRel, sdRel: cmp.sdRel };
      c.decision = decision.reasons;
      this.log(`"${c.name}" development ${c.dev.aggregate.score.toFixed(2)} s/veh: ${decision.accept ? "passes the selection rule" : `rejected (${decision.reasons.join("; ")})`}`, c.agentId ?? c.role);
      if (decision.accept) passed.push(c);
      else {
        c.status = "rejected";
        this.setAgent(c.agentId ?? c.role, { phase: "rejected", message: `Dev rule failed: ${decision.reasons[0]}` });
      }
      this.changed();
    }
    passed.sort((a, b) => a.dev!.aggregate.score - b.dev!.aggregate.score);
    const winner = passed[0];
    for (const c of passed.slice(1)) {
      c.status = "rejected";
      c.decision = [...c.decision, `passed the rule, but ${winner.id} scored better on development`];
      this.setAgent(c.agentId ?? c.role, { phase: "rejected", message: "Passed, but another candidate was better on dev" });
    }
    if (winner) {
      winner.status = "accepted";
      exp.championId = winner.id;
      exp.championHistory.push({
        round,
        policyId: winner.id,
        label: winner.name,
        trainScore: winner.train!.aggregate.score,
        devScore: winner.dev!.aggregate.score,
        at: new Date().toISOString(),
        reason: winner.decision[0],
      });
      this.setAgent(winner.agentId ?? winner.role, { phase: "accepted", message: `New champion: ${winner.decision[0]}` });
      this.log(`New champion "${winner.name}" (dev ${winner.dev!.aggregate.score.toFixed(2)} s/veh)`, winner.agentId ?? winner.role);
    } else {
      this.log(`Round ${round}: champion retained`);
    }

    // 6. Lessons fed into the next round.
    for (const c of cands) exp.lessons.push(this.lessonFor(c));
    if (exp.lessons.length > 40) exp.lessons = exp.lessons.slice(-40);
    const finished = exp.rounds[exp.rounds.length - 1];
    finished.finishedAt = new Date().toISOString();
    finished.championAfter = exp.championId;
    const trains = cands.filter((c) => c.train).map((c) => c.train!.aggregate.score);
    finished.bestCandidateTrain = trains.length ? Math.min(...trains) : null;
    this.changed();
  }

  private lessonFor(c: CandidateRecord): string {
    const pct = c.trainVsChampionPct === undefined || c.trainVsChampionPct === null ? "" : ` (${c.trainVsChampionPct >= 0 ? "+" : ""}${c.trainVsChampionPct.toFixed(1)}% train)`;
    const head = `R${c.round} ${c.roleLabel} "${c.name}"`;
    switch (c.status) {
      case "accepted":
        return `${head}${pct} ACCEPTED: ${c.decision[0]}. Idea: ${c.hypothesis.slice(0, 160)}`;
      case "rejected":
        return `${head}${pct} improved training but failed the dev rule (${c.decision[0]}). Idea: ${c.hypothesis.slice(0, 160)}`;
      case "screened-out":
        return `${head}${pct} did not beat the champion on training. Idea tried: ${c.hypothesis.slice(0, 160)}`;
      case "invalid":
        return `${head} was invalid: ${c.validationErrors[c.validationErrors.length - 1] ?? c.decision[0]}`;
      default:
        return `${head} failed: ${c.decision[0]}`;
    }
  }

  async freezeAndTest(): Promise<void> {
    const exp = this.exp;
    if (!exp) throw new Error("No experiment loaded");
    if (this.busy) throw new Error(`Busy: ${this.busy}`);
    if (exp.heldOut) throw new Error("Already frozen and tested");
    this.busy = "Evaluating frozen champion on held-out scenarios";
    this.changed();
    try {
      const frozen = { championId: exp.championId, frozenAt: new Date().toISOString() };
      this.log(`Champion ${frozen.championId} frozen; generating ${exp.suiteSpecs.heldOut.count} unseen held-out scenarios`);
      const scenarios = generateHeldOutSuite(this.net, exp, frozen);
      const champ = this.policyById(frozen.championId)!;
      const fixed = await this.evalSuite(exp.baselines.fixed.policy, scenarios);
      const heuristic = await this.evalSuite(exp.baselines.heuristic.policy, scenarios);
      const champion = await this.evalSuite(champ.policy, scenarios);
      const asEval = (r: SuiteResult) => ({ suite: "heldout", ...r });
      exp.heldOut = {
        frozenAt: frozen.frozenAt,
        championId: frozen.championId,
        seedBase: scenarios[0]?.seed ?? 0,
        manifests: scenarios.map(manifestOf),
        results: { [FIXED_BASELINE_ID]: fixed, [HEURISTIC_BASELINE_ID]: heuristic, champion },
        comparisons: {
          championVsFixed: compare(asEval(champion), asEval(fixed)),
          championVsHeuristic: compare(asEval(champion), asEval(heuristic)),
          heuristicVsFixed: compare(asEval(heuristic), asEval(fixed)),
        },
      };
      this.heldOut = scenarios;
      const c = exp.heldOut.comparisons;
      this.log(`Held-out: champion ${champion.aggregate.score.toFixed(2)} vs fixed ${fixed.aggregate.score.toFixed(2)} (${c.championVsFixed.relImprovement?.toFixed(1)}%) and heuristic ${heuristic.aggregate.score.toFixed(2)} (${c.championVsHeuristic.relImprovement?.toFixed(1)}%)`);
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  scenarioList() {
    const exp = this.exp;
    if (!exp) return [];
    return [
      ...exp.suites.train.map((m) => ({ ...m })),
      ...exp.suites.dev.map((m) => ({ ...m })),
      ...(exp.heldOut ? exp.heldOut.manifests : []),
    ];
  }

  getReplay(scenarioId: string, controllerId: string): Replay {
    const exp = this.exp;
    if (!exp) throw new Error("No experiment loaded");
    const pool = [...this.train, ...this.dev, ...(exp.heldOut && this.heldOut ? this.heldOut : [])];
    const sc = pool.find((s) => s.id === scenarioId);
    if (!sc) throw new Error(`Unknown or unavailable scenario ${scenarioId}`);
    const resolvedId = controllerId === "champion" ? exp.championId : controllerId;
    const pol = this.policyById(resolvedId);
    if (!pol) throw new Error(`Unknown controller ${controllerId}`);
    const key = `${scenarioId}__${resolvedId}`;
    const cached = this.replayCache.get(key);
    if (cached) return cached;
    const dir = path.join(runDir(exp.runId), "replays");
    const file = path.join(dir, `${key}.json`);
    let rep: Replay | null = null;
    if (existsSync(file)) {
      const r = JSON.parse(readFileSync(file, "utf8")) as Replay;
      if (r.scenarioChecksum === sc.checksum && r.simulatorVersion === SIMULATOR_VERSION) rep = r;
    }
    if (!rep) {
      rep = recordReplay(this.net, sc, pol.policy, resolvedId, pol.label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(rep));
    }
    this.replayCache.set(key, rep);
    if (this.replayCache.size > 16) this.replayCache.delete(this.replayCache.keys().next().value!);
    return rep;
  }

  publicState() {
    return {
      experiment: this.exp,
      agents: Object.values(this.agents),
      activity: this.activity.slice(-60),
      busy: this.busy,
      progress: this.progress,
      live: this.live,
      provider: this.provider.info(),
      runs: listRuns(),
      storage: mongo.status,
      scenarios: this.scenarioList(),
    };
  }
}
