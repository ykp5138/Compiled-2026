// Model providers. LuminalProvider calls Luminal Cloud's OpenAI-compatible chat completions endpoint.
// MockProvider is a clearly labelled development stand-in that never touches the network;
// its output is always recorded with provider "mock" and never presented as Luminal activity.
import { config, luminalConfigured, luminalHost, redact } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallRecord {
  provider: "luminal" | "mock";
  /** ISO time the call started (used for the parallel-agent timeline). */
  startedAt?: string;
  model: string;
  latencyMs: number;
  attempts: number;
  finishReason: string | null;
  usage: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedTokens?: number } | null;
  error?: string;
}

export interface CompletionResult {
  content: string;
  call: CallRecord;
}

export interface ProviderInfo {
  kind: "luminal" | "mock";
  model: string;
  host: string;
  configured: boolean;
  label: string;
}

export interface AgentProvider {
  info(): ProviderInfo;
  complete(messages: ChatMessage[], opts: { temperature: number; mockRole?: string; mockSeed?: number; mockContext?: unknown }): Promise<CompletionResult>;
  check(): Promise<{ ok: boolean; detail: string; latencyMs: number; models?: string[] }>;
}

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LuminalProvider implements AgentProvider {
  private sem = new Semaphore(Math.max(1, config.luminal.maxConcurrency));

  info(): ProviderInfo {
    return {
      kind: "luminal",
      model: config.luminal.model,
      host: luminalHost(),
      configured: luminalConfigured(),
      label: `Luminal Cloud · ${config.luminal.model}`,
    };
  }

  private headers() {
    return { Authorization: `Bearer ${config.luminal.apiKey}`, "Content-Type": "application/json" };
  }

  async check() {
    const t0 = Date.now();
    if (!luminalConfigured()) {
      return { ok: false, detail: "LUMINAL_API_KEY, LUMINAL_BASE_URL and LUMINAL_MODEL must all be set", latencyMs: 0 };
    }
    try {
      const res = await fetch(`${config.luminal.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
      const latencyMs = Date.now() - t0;
      if (!res.ok) return { ok: false, detail: `GET /models returned HTTP ${res.status}`, latencyMs };
      const body = (await res.json()) as { data?: { id: string }[] };
      const models = (body.data ?? []).map((m) => m.id);
      const has = models.includes(config.luminal.model);
      return {
        ok: has,
        detail: has ? `Connected; model ${config.luminal.model} is available` : `Connected, but ${config.luminal.model} is not in the model list`,
        latencyMs,
        models,
      };
    } catch (e) {
      return { ok: false, detail: redact(`Connection failed: ${(e as Error).message}`), latencyMs: Date.now() - t0 };
    }
  }

  async complete(messages: ChatMessage[], opts: { temperature: number }): Promise<CompletionResult> {
    return this.sem.run(async () => {
      const t0 = Date.now();
      const startedAt = new Date(t0).toISOString();
      let attempts = 0;
      let lastErr = "";
      while (attempts < config.luminal.maxRetries) {
        attempts++;
        try {
          const res = await fetch(`${config.luminal.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this.headers(),
            // Streaming keeps long reasoning responses alive; Luminal returns 503 for
            // non-streaming requests that run longer than ~20 s.
            body: JSON.stringify({
              model: config.luminal.model,
              messages,
              temperature: opts.temperature,
              max_tokens: config.luminal.maxTokens,
              stream: true,
              stream_options: { include_usage: true },
            }),
            signal: AbortSignal.timeout(config.luminal.timeoutMs),
          });
          if (res.status === 429 || res.status >= 500) {
            lastErr = `HTTP ${res.status}`;
            const retryAfter = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempts - 1));
            continue;
          }
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
          }
          let content = "";
          let finishReason: string | null = null;
          let usage: CallRecord["usage"] = null;
          let streamError = "";
          const decoder = new TextDecoder();
          let buf = "";
          const handle = (line: string) => {
            if (!line.startsWith("data:")) return;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") return;
            const j = JSON.parse(data) as {
              error?: { message?: string };
              choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                prompt_tokens_details?: { cached_tokens?: number };
                completion_tokens_details?: { reasoning_tokens?: number };
              };
            };
            if (j.error) streamError = j.error.message ?? "stream error";
            const ch = j.choices?.[0];
            if (ch?.delta?.content) content += ch.delta.content;
            if (ch?.finish_reason) finishReason = ch.finish_reason;
            if (j.usage) {
              usage = {
                promptTokens: j.usage.prompt_tokens,
                completionTokens: j.usage.completion_tokens,
                reasoningTokens: j.usage.completion_tokens_details?.reasoning_tokens,
                cachedTokens: j.usage.prompt_tokens_details?.cached_tokens,
              };
            }
          };
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              try {
                handle(line);
              } catch {
                // ignore malformed SSE line
              }
            }
          }
          if (buf.trim()) {
            try {
              handle(buf.trim());
            } catch {
              // ignore
            }
          }
          if (streamError && !content) throw new Error(`stream error: ${streamError}`);
          return {
            content,
            call: {
              provider: "luminal",
              startedAt,
              model: config.luminal.model,
              latencyMs: Date.now() - t0,
              attempts,
              finishReason,
              usage,
            },
          };
        } catch (e) {
          const err = e as Error;
          lastErr = err.name === "TimeoutError" ? `timeout after ${config.luminal.timeoutMs} ms` : err.message;
          if (/^HTTP 4\d\d/.test(lastErr)) break; // non-retryable client error
          await sleep(2000 * 2 ** (attempts - 1));
        }
      }
      return {
        content: "",
        call: {
          provider: "luminal",
          startedAt,
          model: config.luminal.model,
          latencyMs: Date.now() - t0,
          attempts,
          finishReason: null,
          usage: null,
          error: redact(lastErr || "unknown error"),
        },
      };
    });
  }
}

/**
 * Development provider: deterministic random perturbations of the champion policy.
 * Used only when Luminal is not configured or AGENT_PROVIDER=mock. Clearly labelled everywhere.
 */
export class MockProvider implements AgentProvider {
  info(): ProviderInfo {
    return { kind: "mock", model: "dev-mock", host: "", configured: true, label: "Development provider (mock, not Luminal)" };
  }
  async check() {
    return { ok: true, detail: "Mock development provider: no network calls, proposals are random perturbations", latencyMs: 0 };
  }
  async complete(_messages: ChatMessage[], opts: { temperature: number; mockRole?: string; mockSeed?: number; mockContext?: unknown }): Promise<CompletionResult> {
    const { mockPropose } = await import("./mock");
    const t0 = Date.now();
    const content = mockPropose(opts.mockRole ?? "queue", opts.mockSeed ?? 1, opts.mockContext);
    return {
      content,
      call: { provider: "mock", startedAt: new Date(t0).toISOString(), model: "dev-mock", latencyMs: Date.now() - t0, attempts: 1, finishReason: "stop", usage: null },
    };
  }
}

export function createProvider(): AgentProvider {
  if (config.provider === "mock" || !luminalConfigured()) return new MockProvider();
  return new LuminalProvider();
}
