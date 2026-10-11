// Server-side configuration. Secrets are read from the environment / .env and never sent to the client.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore malformed .env; explicit environment variables still apply.
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  experimentsDir: process.env.EXPERIMENTS_DIR ? path.resolve(process.env.EXPERIMENTS_DIR) : path.join(ROOT, "experiments"),
  provider: (process.env.AGENT_PROVIDER ?? "luminal") as "luminal" | "mock",
  luminal: {
    apiKey: process.env.LUMINAL_API_KEY ?? "",
    baseUrl: (process.env.LUMINAL_BASE_URL ?? "").replace(/\/+$/, ""),
    model: process.env.LUMINAL_MODEL ?? "",
    timeoutMs: Number(process.env.LUMINAL_TIMEOUT_MS ?? 300000),
    maxConcurrency: Number(process.env.LUMINAL_MAX_CONCURRENCY ?? 6),
    maxRetries: 3,
    maxTokens: Number(process.env.LUMINAL_MAX_TOKENS ?? 32000),
  },
  experiment: {
    rounds: Number(process.env.ROUNDS ?? 5),
    /** 2 = six concurrent agents (refine + explore per role); 1 = three. */
    variantsPerRole: Number(process.env.VARIANTS_PER_ROLE ?? 2),
    horizon: Number(process.env.SIM_HORIZON ?? 900),
    drain: Number(process.env.SIM_DRAIN ?? 300),
    train: { count: Number(process.env.TRAIN_EPISODES ?? 8), seedBase: 1001 },
    dev: { count: Number(process.env.DEV_EPISODES ?? 4), seedBase: 2001 },
    heldOutCount: Number(process.env.HELDOUT_EPISODES ?? 12),
  },
};

export function luminalConfigured(): boolean {
  return Boolean(config.luminal.apiKey && config.luminal.baseUrl && config.luminal.model);
}

/** Host only — safe to show in UI and reports. */
export function luminalHost(): string {
  try {
    return new URL(config.luminal.baseUrl).host;
  } catch {
    return "";
  }
}

/** Remove anything that looks like a credential from text before logging or saving it. */
export function redact(text: string): string {
  let out = text;
  if (config.luminal.apiKey) out = out.split(config.luminal.apiKey).join("[REDACTED]");
  return out.replace(/lum_(live|test)_[A-Za-z0-9]+/g, "[REDACTED]");
}
