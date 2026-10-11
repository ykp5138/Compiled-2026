# GreenWave State College

**Agents propose. Simulation tests. Traffic policies improve.**

A self-improving team of three AI agents (DeepSeek on Luminal Cloud) that optimizes traffic-signal control policies for a simplified, synthetic simulation of downtown State College, PA. Built for *Track 1 · Challenge A: Build a Self-Improving Agent Team*.

The UI has **four layouts** from the Claude Design canvas, switchable at the top of the page (or with `#a`–`#d` in the URL):

| Layout | Style |
|---|---|
| **A · Ops command center** | dense, dark |
| **B · Story mode** | a five-chapter narrative for judges |
| **C · Split-screen versus** | baseline vs champion with a live head-to-head scoreboard and a tabbed drawer |
| **D · Lab notebook** | a round-by-round experiment log with a sticky replay |

All four show the same live data and replays.

The UI's **Parallel agent timeline** draws every recorded model call as a bar, so you can see the agents in a round running at the same time, and how much wall-clock time parallelism saves compared with running them one after another.

- **Agents:** each round, six concurrent model calls each propose one declarative JSON signal policy. There are three roles, each with its own parameter area: the Corridor Coordinator (coordination and offsets), the Queue Optimizer (adaptive weights, holds and hysteresis) and the Robustness Optimizer (max greens, oldest-wait and phase bias). Each role runs as two variants: **refine**, an incremental change to the champion, and **explore**, a structurally different idea.
- **Orchestrator:** ordinary code. It validates proposals, simulates them on identical training scenarios, checks promising ones on a development suite with a predefined selection rule, keeps or replaces the champion, and feeds measured outcomes back into the next round.
- **Final test:** after freezing, the champion is tested once on a **held-out suite that the optimization loop never sees**.
- **Demo:** two synchronized animated maps, a baseline controller on the left and the selected agent-designed controller on the right, both replaying the same recorded deterministic simulation demand.

> Simplified State College network · synthetic traffic. The geometry is schematic, the demand is synthetic, and the signal timings are simulation assumptions, not municipal plans. The foundation model is not retrained: the system improves *policies* using experiment feedback and persistent experiment memory.

## Setup

Requires Node 20.6+ (developed on Node 22).

```bash
npm install
cp .env.example .env      # then fill in LUMINAL_API_KEY
npm run check:luminal     # verifies endpoint, model and a test completion
npm run build             # builds the UI into web/dist
npm start                 # http://localhost:8787 (API + built UI)
# or, for development with hot reload:
npm run dev               # UI on http://localhost:5173, API on :8787
```

`.env` settings:

| Variable | Meaning |
|---|---|
| `LUMINAL_API_KEY` | Luminal key (server-side only; never sent to the browser or written to reports) |
| `LUMINAL_BASE_URL` | `https://flash.luminal.cloud/v1` (OpenAI-compatible chat completions) |
| `LUMINAL_MODEL` | `deepseek-ai/DeepSeek-V4.1-Flash` |
| `LUMINAL_TIMEOUT_MS`, `LUMINAL_MAX_TOKENS`, `LUMINAL_MAX_CONCURRENCY` | Call limits (defaults 300000 / 32000 / 6) |
| `AGENT_PROVIDER=mock` | Forces the development provider |
| `VARIANTS_PER_ROLE` | 2 (default) = six agents; 1 = three agents |
| `ROUNDS`, `SIM_HORIZON`, `SIM_DRAIN`, `TRAIN_EPISODES`, `DEV_EPISODES`, `HELDOUT_EPISODES` | Experiment size |

Without Luminal credentials the app runs with a **development provider** that makes random perturbations. It is labelled "Development provider · not Luminal" everywhere and its candidates carry a `dev mock` badge.

**Luminal note:** requests are streamed (`stream: true`). Luminal returned `503 service_unavailable` for non-streaming requests that ran longer than about 20 s, and DeepSeek V4.1 Flash usually reasons for 30–100 s per proposal.

## Reproducible commands

```bash
npm test                                  # determinism, conservation, signal safety, validation, held-out isolation
npm run bench                             # calibrate both baselines on training; report training + development
npm run optimize -- --new --rounds 5      # new experiment + 5 rounds with real Luminal agents
npm run optimize -- --run <runId> --rounds 2   # continue an experiment
npm run final -- --run <runId>            # freeze champion, evaluate once on unseen held-out traffic
```

Each experiment is saved to `experiments/<runId>/experiment.json` and contains:
- run metadata, the simulator version and the network file;
- scenario manifests with checksums;
- provider and model metadata;
- every proposal (hypothesis, explanation, policy, parent, validation errors, repair attempts, call latency and token usage);
- per-scenario results, champion history, lessons, and held-out results.

Replays are cached in `experiments/<runId>/replays/`. The UI's **Download report** button returns the same JSON.

## Layout

```
sim/            shared deterministic simulation (used by benchmarks, server and replays)
  network.json    editable network data (nodes, links, lanes, movements, phases, demand, map labels)
  network.ts      derivation: lanes, conflicts, routes
  scenarios.ts    seeded synthetic demand, pre-generated arrival schedules
  simulator.ts    lane-based simulator, signal safety, metrics, frame recording
  policy.ts       JSON policy schema, validator, deterministic interpreter
  baselines.ts    fixed-time (Webster + grid) and queue-responsive heuristic
  evaluate.ts     suites, paired comparisons, selection rule, bottleneck summaries
server/         Node API, SSE, Luminal provider, agents, orchestrator, JSON storage, CLIs
  heldout.ts      the only module that generates held-out scenarios (requires a frozen champion)
web/            React + Vite + canvas UI
tests/          vitest suites
docs/           SIMULATION.md (assumptions, score, protocol) · DEMO_SCRIPT.md
```

See [docs/SIMULATION.md](docs/SIMULATION.md) for the model assumptions, score formula and evaluation protocol, and [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for the two-minute demo.
