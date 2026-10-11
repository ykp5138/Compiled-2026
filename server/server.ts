// HTTP API + server-sent events. Credentials stay in this process; responses never include them.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { config, redact, ROOT } from "./config";
import { Orchestrator } from "./orchestrator";

const orch = new Orchestrator();
const clients = new Set<ServerResponse>();

function send(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage, extraHeaders: Record<string, string> = {}) {
  const json = redact(JSON.stringify(body));
  const gzip = req && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && json.length > 4096;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    ...extraHeaders,
  });
  res.end(gzip ? gzipSync(json) : json);
}

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${redact(JSON.stringify(data))}\n\n`;
  for (const c of clients) c.write(payload);
}

orch.on("state", () => broadcast("state", orch.publicState()));
orch.on("agents", () => broadcast("agents", { agents: Object.values(orch.agents), activity: orch.activity.slice(-60), busy: orch.busy, progress: orch.progress }));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function runInBackground(label: string, fn: () => Promise<void>) {
  fn().catch((e: Error) => {
    console.error(`${label} failed:`, redact(e.message));
    broadcast("error", { message: redact(`${label} failed: ${e.message}`) });
  });
}

const DIST = path.join(ROOT, "web", "dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (!existsSync(DIST)) return false;
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/state" && req.method === "GET") return send(res, 200, orch.publicState(), req);
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: state\ndata: ${redact(JSON.stringify(orch.publicState()))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (p === "/api/check" && req.method === "POST") {
      const result = await orch.provider.check();
      return send(res, 200, { provider: orch.provider.info(), ...result });
    }
    if (p === "/api/rounds" && req.method === "POST") {
      const body = await readJson(req);
      const n = Math.max(1, Math.min(20, Number(body.rounds ?? config.experiment.rounds) || config.experiment.rounds));
      if (orch.busy) return send(res, 409, { error: `Busy: ${orch.busy}` });
      if (orch.exp?.heldOut) return send(res, 409, { error: "Experiment is frozen; start a new experiment to optimize further." });
      runInBackground("Improvement rounds", () => orch.runRounds(n));
      return send(res, 202, { ok: true, rounds: n });
    }
    if (p === "/api/freeze" && req.method === "POST") {
      if (orch.busy) return send(res, 409, { error: `Busy: ${orch.busy}` });
      if (orch.exp?.heldOut) return send(res, 409, { error: "Already frozen and tested." });
      runInBackground("Held-out evaluation", () => orch.freezeAndTest());
      return send(res, 202, { ok: true });
    }
    if (p === "/api/experiments/new" && req.method === "POST") {
      if (orch.busy) return send(res, 409, { error: `Busy: ${orch.busy}` });
      runInBackground("New experiment", () => orch.createExperiment());
      return send(res, 202, { ok: true });
    }
    if (p === "/api/runs/load" && req.method === "POST") {
      const body = await readJson(req);
      const ok = orch.loadRun(String(body.runId ?? ""));
      return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "Run not found" });
    }
    if (p === "/api/replay" && req.method === "GET") {
      const rep = orch.getReplay(url.searchParams.get("scenario") ?? "", url.searchParams.get("controller") ?? "");
      return send(res, 200, rep, req);
    }
    if (p === "/api/report" && req.method === "GET") {
      if (!orch.exp) return send(res, 404, { error: "No experiment" });
      return send(res, 200, orch.exp, undefined, { "Content-Disposition": `attachment; filename="greenwave-${orch.exp.runId}.json"` });
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    if (serveStatic(req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Frontend not built. Run `npm run dev` (Vite on :5173) or `npm run build`.");
  } catch (e) {
    send(res, 400, { error: redact((e as Error).message) });
  }
});

server.listen(config.port, () => {
  const info = orch.provider.info();
  console.log(`GreenWave server on http://localhost:${config.port}  ·  agents: ${info.label}${info.kind === "luminal" ? ` @ ${info.host}` : ""}`);
  runInBackground("Initialization", () => orch.init());
});
