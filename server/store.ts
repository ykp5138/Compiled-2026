// Local JSON experiment storage: experiments/<runId>/experiment.json (+ replays/ cache).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, redact } from "./config";
import type { Experiment } from "./types";

export function runDir(runId: string): string {
  return path.join(config.experimentsDir, runId);
}

export function saveExperiment(exp: Experiment, keepTimestamp = false): void {
  const dir = runDir(exp.runId);
  mkdirSync(dir, { recursive: true });
  if (!keepTimestamp) exp.updatedAt = new Date().toISOString();
  const file = path.join(dir, "experiment.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, redact(JSON.stringify(exp, null, 1)));
  renameSync(tmp, file);
}

export function loadExperiment(runId: string): Experiment | null {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return null;
  const file = path.join(runDir(runId), "experiment.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Experiment;
}

export interface RunListing {
  runId: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  rounds: number;
  candidates: number;
  frozen: boolean;
}

export function listRuns(): RunListing[] {
  if (!existsSync(config.experimentsDir)) return [];
  const out: RunListing[] = [];
  for (const name of readdirSync(config.experimentsDir)) {
    const file = path.join(config.experimentsDir, name, "experiment.json");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    try {
      const e = JSON.parse(readFileSync(file, "utf8")) as Experiment;
      out.push({
        runId: e.runId,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        provider: e.provider.label,
        rounds: e.rounds.filter((r) => r.finishedAt).length,
        candidates: e.candidates.length,
        frozen: e.heldOut !== null,
      });
    } catch {
      // skip unreadable runs
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function loadAllExperiments(): Experiment[] {
  return listRuns()
    .map((r) => loadExperiment(r.runId))
    .filter((e): e is Experiment => e !== null);
}
