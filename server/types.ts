// Persisted experiment record. Everything shown in the UI comes from these fields.
import type { Aggregate, CalibrationLog, EpisodeMetrics, PairedComparison, Policy, RawNetwork, ScenarioManifest, ScenarioType } from "../sim";
import type { RoleId } from "./agents";
import type { CallRecord, ProviderInfo } from "./providers";

export interface SuiteResult {
  aggregate: Aggregate;
  perScenario: EpisodeMetrics[];
}

export type CandidateStatus = "invalid" | "provider-error" | "screened-out" | "rejected" | "accepted";

export interface CandidateRecord {
  id: string;
  round: number;
  role: RoleId;
  /** Agent identity, e.g. "corridor-explore" (absent in runs recorded with one variant per role). */
  agentId?: string;
  variant?: string;
  roleLabel: string;
  provider: "luminal" | "mock";
  name: string;
  parentId: string;
  claimedParentId: string;
  hypothesis: string;
  explanation: string;
  policy: Policy | null;
  status: CandidateStatus;
  validationErrors: string[];
  validationWarnings: string[];
  repairAttempts: number;
  calls: CallRecord[];
  train?: SuiteResult;
  trainVsChampionPct?: number | null;
  dev?: SuiteResult;
  devComparison?: Pick<PairedComparison, "relImprovement" | "wins" | "losses" | "ties" | "meanRel" | "sdRel">;
  decision: string[];
  createdAt: string;
}

export interface BaselineRecord {
  id: string;
  label: string;
  policy: Policy;
  calibration: CalibrationLog;
  train: SuiteResult;
  dev: SuiteResult;
}

export interface ChampionEntry {
  round: number;
  policyId: string;
  label: string;
  trainScore: number;
  devScore: number;
  at: string;
  reason: string;
}

export interface RoundRecord {
  round: number;
  startedAt: string;
  finishedAt?: string;
  candidateIds: string[];
  championBefore: string;
  championAfter?: string;
  bestCandidateTrain?: number | null;
}

export interface HeldOutRecord {
  frozenAt: string;
  championId: string;
  seedBase: number;
  manifests: ScenarioManifest[];
  results: Record<string, SuiteResult>;
  comparisons: {
    championVsFixed: PairedComparison;
    championVsHeuristic: PairedComparison;
    heuristicVsFixed: PairedComparison;
  };
}

export interface Experiment {
  runId: string;
  createdAt: string;
  updatedAt: string;
  simulatorVersion: string;
  network: RawNetwork;
  demand: { horizon: number; drain: number; dt: number };
  suiteSpecs: {
    train: { count: number; seedBase: number; types: ScenarioType[] };
    dev: { count: number; seedBase: number; types: ScenarioType[] };
    heldOut: { count: number; types: ScenarioType[] };
  };
  suites: { train: ScenarioManifest[]; dev: ScenarioManifest[] };
  selectionRule: string[];
  scoreDefinition: string;
  provider: ProviderInfo;
  baselines: { fixed: BaselineRecord; heuristic: BaselineRecord };
  championId: string;
  championHistory: ChampionEntry[];
  candidates: CandidateRecord[];
  rounds: RoundRecord[];
  lessons: string[];
  heldOut: HeldOutRecord | null;
  commands: string[];
}
