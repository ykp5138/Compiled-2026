// Optional MongoDB (Atlas) mirror for experiments. Local JSON stays the working copy; when MONGODB_URI is set,
// every save is also upserted to MongoDB, and runs that exist only in MongoDB are pulled down at startup.
// Collections: experiments (one doc per run), candidates (one per proposal), rounds (one per round), ablations.
import { MongoClient, type AnyBulkWriteOperation, type Db, type Document } from "mongodb";
import { config, redact } from "./config";
import type { CandidateRecord, Experiment, RoundRecord } from "./types";

export interface StorageStatus {
  kind: "json" | "mongodb";
  connected: boolean;
  database: string;
  host: string;
  lastSyncAt: string | null;
  lastError: string | null;
  pulled: number;
  pushed: number;
}

type ExpDoc = Omit<Experiment, "candidates" | "rounds"> & { _id: string; candidateCount: number; roundCount: number };
type CandDoc = CandidateRecord & { _id: string; runId: string; seq: number };
type RoundDoc = RoundRecord & { _id: string; runId: string };

/** Split one experiment into collection documents (pure; tested). */
export function splitExperiment(exp: Experiment): { experiment: ExpDoc; candidates: CandDoc[]; rounds: RoundDoc[] } {
  const { candidates, rounds, ...rest } = exp;
  return {
    experiment: { ...rest, _id: exp.runId, candidateCount: candidates.length, roundCount: rounds.length },
    candidates: candidates.map((c, seq) => ({ ...c, _id: `${exp.runId}/${c.id}`, runId: exp.runId, seq })),
    rounds: rounds.map((r) => ({ ...r, _id: `${exp.runId}/r${r.round}`, runId: exp.runId })),
  };
}

/** Reassemble an experiment from collection documents (pure; tested). */
export function joinExperiment(e: Document, candidates: Document[], rounds: Document[]): Experiment {
  const { _id: _a, candidateCount: _b, roundCount: _c, ...rest } = e;
  const strip = <T>(d: Document, extra: string[]) => {
    const o: Document = { ...d };
    for (const k of ["_id", ...extra]) delete o[k];
    return o as T;
  };
  return {
    ...(rest as Omit<Experiment, "candidates" | "rounds">),
    candidates: [...candidates].sort((a, b) => a.seq - b.seq).map((d) => strip<CandidateRecord>(d, ["runId", "seq"])),
    rounds: [...rounds].sort((a, b) => a.round - b.round).map((d) => strip<RoundRecord>(d, ["runId"])),
  };
}

function hostOf(uri: string): string {
  const m = uri.match(/@([^/?]+)/) ?? uri.match(/^mongodb(?:\+srv)?:\/\/([^/?]+)/);
  return m ? m[1] : "";
}

class MongoMirror {
  readonly enabled = Boolean(config.mongo.uri);
  status: StorageStatus = {
    kind: this.enabled ? "mongodb" : "json",
    connected: false,
    database: config.mongo.db,
    host: hostOf(config.mongo.uri),
    lastSyncAt: null,
    lastError: null,
    pulled: 0,
    pushed: 0,
  };
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private pending = new Map<string, Experiment>();
  private inflight = new Set<string>();
  onChange: () => void = () => undefined;

  private fail(e: unknown) {
    this.status.lastError = redact((e as Error).message ?? String(e));
    this.onChange();
  }

  async connect(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.db) return true;
    try {
      this.client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10000, appName: "greenwave-state-college" });
      await this.client.connect();
      this.db = this.client.db(config.mongo.db);
      await Promise.all([
        this.db.collection("candidates").createIndex({ runId: 1, seq: 1 }),
        this.db.collection("candidates").createIndex({ status: 1, role: 1 }),
        this.db.collection("rounds").createIndex({ runId: 1, round: 1 }),
      ]);
      this.status.connected = true;
      this.status.lastError = null;
      this.onChange();
      return true;
    } catch (e) {
      this.status.connected = false;
      this.fail(e);
      return false;
    }
  }

  /** Coalescing write-through: at most one in-flight push per run, latest state wins. */
  schedule(exp: Experiment) {
    if (!this.enabled) return;
    this.pending.set(exp.runId, JSON.parse(JSON.stringify(exp)) as Experiment);
    void this.drain(exp.runId);
  }

  private async drain(runId: string) {
    if (this.inflight.has(runId)) return;
    this.inflight.add(runId);
    try {
      while (this.pending.has(runId)) {
        const exp = this.pending.get(runId)!;
        this.pending.delete(runId);
        await this.push(exp);
      }
    } finally {
      this.inflight.delete(runId);
    }
  }

  async push(exp: Experiment): Promise<boolean> {
    if (!(await this.connect())) return false;
    try {
      const { experiment, candidates, rounds } = splitExperiment(exp);
      const db = this.db!;
      await db.collection<ExpDoc>("experiments").replaceOne({ _id: experiment._id }, experiment, { upsert: true });
      if (candidates.length) {
        const ops: AnyBulkWriteOperation<CandDoc>[] = candidates.map((c) => ({ replaceOne: { filter: { _id: c._id }, replacement: c, upsert: true } }));
        await db.collection<CandDoc>("candidates").bulkWrite(ops, { ordered: false });
      }
      if (rounds.length) {
        const ops: AnyBulkWriteOperation<RoundDoc>[] = rounds.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } }));
        await db.collection<RoundDoc>("rounds").bulkWrite(ops, { ordered: false });
      }
      this.status.pushed++;
      this.status.lastSyncAt = new Date().toISOString();
      this.status.lastError = null;
      this.onChange();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  async runIds(): Promise<string[]> {
    if (!(await this.connect())) return [];
    return (await this.db!.collection<ExpDoc>("experiments").find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  }

  async fetch(runId: string): Promise<Experiment | null> {
    if (!(await this.connect())) return null;
    const db = this.db!;
    const e = await db.collection<ExpDoc>("experiments").findOne({ _id: runId });
    if (!e) return null;
    const [cands, rounds] = await Promise.all([
      db.collection("candidates").find({ runId }).toArray(),
      db.collection("rounds").find({ runId }).toArray(),
    ]);
    return joinExperiment(e, cands, rounds);
  }

  /** Two-way reconcile: pull runs missing locally, push local runs missing remotely. */
  async sync(local: Experiment[], writeLocal: (e: Experiment) => void): Promise<{ pulled: string[]; pushed: string[] }> {
    const out = { pulled: [] as string[], pushed: [] as string[] };
    if (!(await this.connect())) return out;
    try {
      const remote = new Set(await this.runIds());
      const localIds = new Set(local.map((e) => e.runId));
      for (const id of remote) {
        if (localIds.has(id)) continue;
        const exp = await this.fetch(id);
        if (exp) {
          writeLocal(exp);
          out.pulled.push(id);
        }
      }
      for (const exp of local) {
        if (remote.has(exp.runId)) continue;
        if (await this.push(exp)) out.pushed.push(exp.runId);
      }
      this.status.pulled += out.pulled.length;
      this.status.lastSyncAt = new Date().toISOString();
      this.onChange();
    } catch (e) {
      this.fail(e);
    }
    return out;
  }

  async pushDoc(collection: string, id: string, doc: Document): Promise<boolean> {
    if (!(await this.connect())) return false;
    try {
      await this.db!.collection<Document>(collection).replaceOne({ _id: id as unknown as Document["_id"] }, { ...doc, _id: id }, { upsert: true });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  async counts(): Promise<Record<string, number>> {
    if (!(await this.connect())) return {};
    const db = this.db!;
    const names = ["experiments", "candidates", "rounds", "ablations"];
    const vals = await Promise.all(names.map((n) => db.collection(n).countDocuments()));
    return Object.fromEntries(names.map((n, i) => [n, vals[i]]));
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.db = null;
  }
}

export const mongo = new MongoMirror();
