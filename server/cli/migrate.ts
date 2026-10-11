// npm run migrate:mongo — copies every local run (experiments/<runId>/experiment.json) and ablation summary
// into MongoDB, then reads them back to verify. Requires MONGODB_URI in .env.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { joinExperiment, mongo, splitExperiment } from "../mongo";
import { loadAllExperiments } from "../store";

if (!mongo.enabled) {
  console.log("MONGODB_URI is not set in .env. Add MONGODB_URI (and optionally MONGODB_DB) and run again.");
  process.exit(1);
}
console.log(`Connecting to ${mongo.status.host}, database "${config.mongo.db}"…`);
if (!(await mongo.connect())) {
  console.log(`Connection failed: ${mongo.status.lastError}`);
  console.log("Check: database user/password in the URI, Network Access allows your IP, cluster finished deploying.");
  process.exit(1);
}
const runs = loadAllExperiments();
for (const exp of runs) {
  const ok = await mongo.push(exp);
  const back = ok ? await mongo.fetch(exp.runId) : null;
  const same = back !== null && JSON.stringify(back) === JSON.stringify(joinExperiment(splitExperiment(exp).experiment, splitExperiment(exp).candidates, splitExperiment(exp).rounds));
  console.log(`${ok ? "✓" : "✗"} ${exp.runId}: ${exp.candidates.length} candidates, ${exp.rounds.length} rounds${exp.heldOut ? ", held-out" : ""}${ok ? (same ? " · verified" : " · VERIFY MISMATCH") : ` · ${mongo.status.lastError}`}`);
}
const abDir = path.join(config.experimentsDir, "ablations");
if (existsSync(abDir)) {
  for (const f of readdirSync(abDir).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(path.join(abDir, f), "utf8"));
    const ok = await mongo.pushDoc("ablations", f.replace(/\.json$/, ""), doc);
    console.log(`${ok ? "✓" : "✗"} ablation ${f}`);
  }
}
console.log("Collection counts:", await mongo.counts());
await mongo.close();
