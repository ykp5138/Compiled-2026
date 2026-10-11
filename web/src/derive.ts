// Pure helpers that turn the persisted experiment into view data. Every number shown in any layout
// comes from these functions (i.e. from recorded runs), never from constants in the UI.
import type { CandidateRecord, Experiment, Replay } from "./api";

export const ROLES = ["corridor", "queue", "robustness"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { corridor: "Corridor", queue: "Queue", robustness: "Robustness" };

export function agentKey(c: CandidateRecord): string {
  return c.agentId ?? c.role;
}

export interface RoundsRow {
  label: string;
  round: number;
  perRole: Partial<Record<Role, { score: number; accepted: boolean }>>;
  champDev: number;
  changed: boolean;
}

export function roundsTable(exp: Experiment): RoundsRow[] {
  const hist = exp.championHistory;
  const rows: RoundsRow[] = [{ label: "Start", round: 0, perRole: {}, champDev: hist[0]?.devScore ?? NaN, changed: false }];
  for (const r of exp.rounds.filter((x) => x.finishedAt)) {
    const cands = exp.candidates.filter((c) => c.round === r.round && c.train);
    const perRole: RoundsRow["perRole"] = {};
    for (const role of ROLES) {
      const rc = cands.filter((c) => c.role === role);
      if (!rc.length) continue;
      const best = rc.reduce((a, b) => (a.train!.aggregate.score <= b.train!.aggregate.score ? a : b));
      perRole[role] = { score: best.train!.aggregate.score, accepted: rc.some((c) => c.status === "accepted") };
    }
    const h = [...hist].filter((x) => x.round <= r.round).pop();
    rows.push({ label: `R${r.round}`, round: r.round, perRole, champDev: h?.devScore ?? NaN, changed: hist.some((x) => x.round === r.round) });
  }
  return rows;
}

export interface LineageItem {
  round: number;
  policyId: string;
  label: string;
  devScore: number;
  trainScore: number;
  role?: Role;
  agentLabel?: string;
  hypothesis?: string;
}

export function lineage(exp: Experiment): LineageItem[] {
  return exp.championHistory.map((h) => {
    const c = exp.candidates.find((x) => x.id === h.policyId);
    return {
      round: h.round,
      policyId: h.policyId,
      label: h.label,
      devScore: h.devScore,
      trainScore: h.trainScore,
      role: c?.role as Role | undefined,
      agentLabel: c?.roleLabel,
      hypothesis: c?.hypothesis,
    };
  });
}

export interface TimelineRow {
  key: string;
  role: Role;
  variant?: string;
  main: number;
  rep: number;
  accepted: boolean;
  name: string;
}

export interface TimelineRound {
  n: number;
  total: number;
  wall: number;
  seq: number;
  rows: TimelineRow[];
}

export function timeline(exp: Experiment): { rounds: TimelineRound[]; wall: number; seq: number; calls: number; agents: number } {
  const rounds: TimelineRound[] = [];
  let calls = 0;
  for (const r of exp.rounds.filter((x) => x.finishedAt)) {
    const t0 = Date.parse(r.startedAt);
    const cands = exp.candidates
      .filter((c) => c.round === r.round)
      .sort((a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || (b.variant ?? "").localeCompare(a.variant ?? ""));
    let wall = 0;
    let seq = 0;
    const rows = cands.map((c) => {
      let cursor = (Date.parse(c.createdAt) - t0) / 1000;
      c.calls.forEach((k) => {
        const start = k.startedAt ? (Date.parse(k.startedAt) - t0) / 1000 : cursor;
        cursor = start + k.latencyMs / 1000;
        wall = Math.max(wall, cursor);
        seq += k.latencyMs / 1000;
        calls++;
      });
      return {
        key: agentKey(c),
        role: c.role as Role,
        variant: c.variant,
        main: (c.calls[0]?.latencyMs ?? 0) / 1000,
        rep: c.calls.slice(1).reduce((a, k) => a + k.latencyMs / 1000, 0),
        accepted: c.status === "accepted",
        name: c.name,
      };
    });
    rounds.push({ n: r.round, total: (Date.parse(r.finishedAt!) - t0) / 1000, wall, seq, rows });
  }
  const agents = Math.max(0, ...rounds.map((r) => r.rows.length));
  return { rounds, wall: rounds.reduce((a, r) => a + r.wall, 0), seq: rounds.reduce((a, r) => a + r.seq, 0), calls, agents };
}

export function fmtDur(s: number): string {
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export interface Live {
  t: number;
  stoppedPerVeh: number;
  completed: number;
  scheduled: number;
  waiting: number;
  p95: number;
  done: boolean;
}

export function liveAt(replay: Replay | null, t: number): Live | null {
  if (!replay) return null;
  const k = Math.max(0, Math.min(replay.frames.length - 1, Math.floor(t / replay.frameEvery)));
  const m = replay.frames[k].m;
  return {
    t,
    stoppedPerVeh: m[0] / replay.scheduled,
    completed: m[2],
    scheduled: replay.scheduled,
    waiting: m[3],
    p95: m[4],
    done: t >= replay.horizon + replay.drain - 1e-6,
  };
}

export function candidateCounts(exp: Experiment) {
  const by: Record<string, number> = {};
  for (const c of exp.candidates) by[c.status] = (by[c.status] ?? 0) + 1;
  return { total: exp.candidates.length, accepted: by.accepted ?? 0, rejected: by.rejected ?? 0, screened: by["screened-out"] ?? 0, invalid: (by.invalid ?? 0) + (by["provider-error"] ?? 0) };
}

export function champDev(exp: Experiment): number {
  return exp.championHistory[exp.championHistory.length - 1]?.devScore ?? NaN;
}
