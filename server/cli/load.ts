import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Experiment } from "../types";

export function loadExperimentFrom(dir: string, runId: string): Experiment | null {
  const file = path.join(dir, runId, "experiment.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Experiment) : null;
}
