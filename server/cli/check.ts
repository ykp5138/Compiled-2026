// npm run check:luminal — verifies Luminal credentials, endpoint and model without printing secrets.
import { config, luminalConfigured } from "../config";
import { LuminalProvider } from "../providers";

const p = new LuminalProvider();
console.log(`Base URL: ${config.luminal.baseUrl || "(unset)"}  Model: ${config.luminal.model || "(unset)"}  Key: ${config.luminal.apiKey ? "set" : "(unset)"}`);
if (!luminalConfigured()) {
  console.log("Luminal is not configured; the app will use the clearly-labelled development provider.");
  process.exit(1);
}
const r = await p.check();
console.log(`${r.ok ? "OK" : "FAILED"}: ${r.detail} (${r.latencyMs} ms)`);
if (r.models) console.log(`Models: ${r.models.join(", ")}`);
if (r.ok) {
  const res = await p.complete([{ role: "user", content: 'Reply with the JSON {"ok": true} and nothing else.' }], { temperature: 0 });
  console.log(res.call.error ? `Completion FAILED: ${res.call.error}` : `Completion OK in ${res.call.latencyMs} ms: ${res.content.trim().slice(0, 80)} (usage ${JSON.stringify(res.call.usage)})`);
}
process.exit(r.ok ? 0 : 1);
