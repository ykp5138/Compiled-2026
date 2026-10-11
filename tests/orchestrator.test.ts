import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(path.join(os.tmpdir(), "greenwave-test-"));
Object.assign(process.env, {
  AGENT_PROVIDER: "mock",
  EXPERIMENTS_DIR: tmp,
  SIM_HORIZON: "240",
  SIM_DRAIN: "60",
  TRAIN_EPISODES: "3",
  DEV_EPISODES: "2",
  HELDOUT_EPISODES: "2",
});

type Orch = import("../server/orchestrator").Orchestrator;
let orch: Orch;

beforeAll(async () => {
  const { Orchestrator } = await import("../server/orchestrator");
  orch = new Orchestrator();
  await orch.createExperiment();
}, 120000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("orchestrator", () => {
  it("agent context contains no held-out scenarios", () => {
    const ctx = JSON.stringify(orch.buildContext(1));
    expect(ctx).not.toMatch(/heldout/i);
    expect(orch.scenarioList().some((s) => s.suite === "heldout")).toBe(false);
  });

  it("malformed provider output and provider errors cannot break a run", async () => {
    const info = { kind: "mock" as const, model: "test", host: "", configured: true, label: "test provider" };
    let call = 0;
    orch.provider = {
      info: () => info,
      check: async () => ({ ok: true, detail: "", latencyMs: 0 }),
      complete: async () => {
        call++;
        if (call === 1) return { content: "", call: { provider: "mock", model: "test", latencyMs: 1, attempts: 3, finishReason: null, usage: null, error: "HTTP 503" } };
        if (call % 2 === 0) return { content: "this is not json {{{", call: { provider: "mock", model: "test", latencyMs: 1, attempts: 1, finishReason: "stop", usage: null } };
        return { content: JSON.stringify({ name: "x", hypothesis: "h", explanation: "e", policy: { schemaVersion: 1, intersections: { NOPE: {} } } }), call: { provider: "mock", model: "test", latencyMs: 1, attempts: 1, finishReason: "stop", usage: null } };
      },
    };
    const before = orch.exp!.championId;
    await orch.runRounds(1);
    const cands = orch.exp!.candidates.filter((c) => c.round === 1);
    expect(cands).toHaveLength(orch.team.length);
    expect(new Set(cands.map((c) => c.agentId)).size).toBe(orch.team.length);
    expect(cands.every((c) => c.status === "invalid" || c.status === "provider-error")).toBe(true);
    expect(cands.some((c) => c.status === "provider-error")).toBe(true);
    expect(cands.filter((c) => c.status === "invalid").every((c) => c.repairAttempts === 1 && c.validationErrors.length > 0)).toBe(true);
    expect(orch.exp!.championId).toBe(before);
    expect(orch.busy).toBeNull();
  }, 120000);

  it("development-provider rounds evaluate candidates on identical scenarios", async () => {
    const { MockProvider } = await import("../server/providers");
    orch.provider = new MockProvider();
    await orch.runRounds(1);
    const cands = orch.exp!.candidates.filter((c) => c.round === 2);
    expect(cands.every((c) => c.provider === "mock")).toBe(true);
    const ids = orch.exp!.suites.train.map((m) => m.id);
    for (const c of cands.filter((x) => x.train)) expect(c.train!.perScenario.map((m) => m.scenarioId)).toEqual(ids);
  }, 120000);

  it("freezing evaluates held-out once and blocks further optimization", async () => {
    await orch.freezeAndTest();
    const h = orch.exp!.heldOut!;
    expect(h.manifests).toHaveLength(2);
    expect(h.manifests.every((m) => m.suite === "heldout")).toBe(true);
    const seen = new Set([...orch.exp!.suites.train, ...orch.exp!.suites.dev].map((m) => m.checksum));
    expect(h.manifests.some((m) => seen.has(m.checksum))).toBe(false);
    await expect(orch.runRounds(1)).rejects.toThrow(/frozen/);
    await expect(orch.freezeAndTest()).rejects.toThrow(/Already frozen/);
  }, 120000);

  it("replays for both panels share the same scenario checksum", () => {
    const sc = orch.exp!.suites.dev[0];
    const a = orch.getReplay(sc.id, "baseline-fixed");
    const b = orch.getReplay(sc.id, "champion");
    expect(a.scenarioChecksum).toBe(b.scenarioChecksum);
    expect(a.frames.length).toBe(b.frames.length);
  });
});

describe("agent output parsing", () => {
  it("extracts JSON from fenced or chatty responses and rejects garbage", async () => {
    const { parseProposal } = await import("../server/agents");
    const ok = parseProposal('Sure!\n```json\n{"name":"a","parentId":"p","hypothesis":"h","explanation":"e","policy":{}}\n```');
    expect(ok.ok).toBe(true);
    expect(parseProposal("nope").ok).toBe(false);
    expect(parseProposal('{"name": "a"}').ok).toBe(false);
  });
});
