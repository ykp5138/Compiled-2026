// Client API. The browser only talks to our Node server; no credentials ever reach it.
import type { ScenarioManifest, Replay } from "../../sim";
import type { ActivityEvent, AgentStatus } from "../../server/orchestrator";
import type { ProviderInfo } from "../../server/providers";
import type { RunListing } from "../../server/store";
import type { Experiment } from "../../server/types";
import type { StorageStatus } from "../../server/mongo";

export type { Experiment, AgentStatus, ActivityEvent, ProviderInfo, RunListing, Replay, ScenarioManifest };
export type { CandidateRecord, SuiteResult } from "../../server/types";

export interface PublicState {
  experiment: Experiment | null;
  agents: AgentStatus[];
  activity: ActivityEvent[];
  busy: string | null;
  progress: { round: number; of: number } | null;
  live: boolean;
  provider: ProviderInfo;
  runs: RunListing[];
  scenarios: ScenarioManifest[];
  storage?: StorageStatus;
  networks?: { id: string; name: string; signals: number }[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  state: () => req<PublicState>("GET", "/api/state"),
  runRounds: (rounds: number) => req<{ ok: boolean }>("POST", "/api/rounds", { rounds }),
  freeze: () => req<{ ok: boolean }>("POST", "/api/freeze"),
  newExperiment: (network?: string) => req<{ ok: boolean }>("POST", "/api/experiments/new", network ? { network } : undefined),
  loadRun: (runId: string) => req<{ ok: boolean }>("POST", "/api/runs/load", { runId }),
  sync: () => req<{ pulled: string[]; pushed: string[] }>("POST", "/api/sync"),
  check: () => req<{ ok: boolean; detail: string; latencyMs: number; provider: ProviderInfo }>("POST", "/api/check"),
  replay: (scenario: string, controller: string) =>
    req<Replay>("GET", `/api/replay?scenario=${encodeURIComponent(scenario)}&controller=${encodeURIComponent(controller)}`),
};

export function subscribe(onState: (s: PublicState) => void, onAgents: (a: Pick<PublicState, "agents" | "activity" | "busy" | "progress" | "storage">) => void, onError: (m: string) => void): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("agents", (e) => onAgents(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string") onError(JSON.parse(data).message);
  });
  return () => es.close();
}

export const fmt = {
  s: (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d)),
  pct: (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`),
};
