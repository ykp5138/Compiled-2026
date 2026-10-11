# Two-minute demo script

Setup before presenting: `npm run build && npm start`, open http://localhost:8787. The recorded run is selected in the run dropdown and shows the **Recorded run** badge. Default scenario: `dev-bursty-2003`. Default maps: fixed-time on the left, current champion on the right.

**0:00–0:20 · Problem and baseline**
- "GreenWave: AI agents improve traffic-signal policies for six downtown signals: College, Beaver, Atherton, Allen, Pugh."
- Point at the label: *simplified network, synthetic traffic*. College is one-way westbound and Beaver one-way eastbound.
- "We start from two honest baselines, both calibrated on training demand only: a Webster fixed-time plan with progression offsets, and a queue-responsive heuristic."

**0:20–0:45 · Side by side**
- Press **Play** at 10×. "Both maps replay the *same* pre-generated arrivals. Cars, queues and signals are the recorded simulator state, not decoration."
- Point to a queue on Beaver at Atherton and the "+N waiting" entry-queue badge. "Blocked arrivals count against the score."
- Point to the metrics under each map: stopped seconds per scheduled vehicle, completed trips, queued vehicles, P95 wait.

**0:45–1:15 · Agents**
- Scroll to **Agent team**. "Each round, three DeepSeek V4.1 Flash calls on Luminal run in parallel: a Corridor Coordinator, a Queue Optimizer and a Robustness Optimizer. Each returns one JSON policy with a hypothesis."
- "Plain code validates it, simulates it on 8 training episodes and, if it beats the champion, checks it on a separate development suite with a fixed rule: ≥1% better, wins at least half the episodes, no side-street or tail-wait regression."
- Open a rejected row in the leaderboard: "This one looked better on training but failed development, so the rule caught it overfitting." Then click the accepted row.

**1:15–1:40 · Improvement over rounds**
- Point to the chart: coloured dots are individual candidates (training), the green step is the best-so-far champion (development), the dashed lines are the baselines.
- Click a **Champion history** entry: the right map reloads that round's policy on the same scenario.

**1:40–2:00 · Unseen traffic**
- Scroll to **Final held-out results**. "After freezing, the champion ran once on 12 freshly generated episodes the loop never saw."
- Read the headline numbers: champion vs fixed-time, champion vs heuristic, wins/losses and spread.
- Close: "The model isn't retrained. The team improves its policies through experiment feedback and memory, and every number shown came from a simulation run."

## Results to quote
Fill these in from the run's report (`experiments/<runId>/experiment.json`) or the UI; never quote numbers that are not there.

### Run `run-20261011-153511` (DeepSeek V4.1 Flash on Luminal, 5 rounds × 3 agents)

| Stage | Champion | Training | Development |
|---|---|---|---|
| Start | Queue-responsive heuristic (baseline) | 35.81 | 34.08 |
| Round 2 | `r2-robustness` "r2-arterial-hold-tune" (Robustness Optimizer) | 34.44 | 32.25 |
| Round 5 | `r5-queue` "r5-atherton-platoon-weight" (Queue Optimizer) | 31.41 | 30.57 |

The fixed-time baseline scored 39.61 on training and 39.82 on development (s per scheduled vehicle; lower is better).

Rounds 1, 3 and 4 kept the champion. Several candidates improved training but failed the development rule; for example, R1 Robustness was +2.9% on training but −5.1% on development, and R3 Queue was +0.8% on training but lost all 4 development episodes.

**Held-out (12 unseen episodes, champion frozen first):**

| Controller | Score | ± sd | Completion | P95 wait | Side-street P95 | Backlog |
|---|---|---|---|---|---|---|
| Fixed-time | 41.83 | 18.13 | 99.0% | 152 s | 168 s | 214 |
| Heuristic | 35.97 | 10.39 | 100.0% | 91 s | 123 s | 4 |
| Champion | 32.06 | 9.63 | 100.0% | 86 s | 124 s | 3 |

- Champion vs heuristic: **+10.9%**, 12 wins / 0 losses (per-episode +1.1% … +19.0%).
- Champion vs fixed-time: **+23.3%**, 10 wins / 2 losses (per-episode −13.5% … +41.5%).
- Heuristic vs fixed-time: +14.0%, 8 wins / 4 losses.

Honest caveats: the network is simplified and the traffic is synthetic. The side-street P95 is essentially unchanged vs the heuristic (124 s vs 123 s). The champion loses to fixed-time on 2 of 12 episodes.

### Run `run-20261011-164124`: 6 parallel agents (3 roles × refine/explore), 6 rounds. This is the main demo run.

| Stage | Champion | Agent | Training | Development |
|---|---|---|---|---|
| Start | Queue-responsive heuristic (baseline) | – | 35.81 | 34.08 |
| Round 1 | "coord-arterial-wave" | Corridor · refine | 35.22 | 33.70 |
| Round 3 | "platoon-anticipation-approach-1p5" | Queue · explore | 33.40 | 31.33 |
| Round 4 | "platoon-hold-tuned-2.5" | Robustness · explore | 31.22 | 29.27 |
| Round 5 | "atherton-two-way-align-college-band" | Corridor · refine | 31.12 | 28.66 |

Of the 36 candidates, 4 were accepted, 11 were rejected by the development rule, 20 were screened out on training, and 1 was invalid.

- **Feedback quote for the demo:** the round 4 winner's hypothesis begins "The champion's platoon-anticipation gain (approaching=1.5) is still leaving platoon tails unconverted…", building directly on the round 3 winner.
- **Parallelism:** 41 model calls took 22m26s of wall-clock time versus 71m49s sequentially, so it was **3.2× faster**.

**Held-out (new suite of 12 unseen episodes, champion frozen first):**

| Controller | Score | ± sd | Completion | P95 wait | Side-street P95 | Unfinished |
|---|---|---|---|---|---|---|
| Fixed-time | 36.40 | 12.10 | 99.6% | 112 s | 134 s | 79 |
| Heuristic | 31.80 | 7.22 | 100.0% | 74 s | 107 s | 0 |
| Champion | 28.24 | 6.28 | 100.0% | 71 s | 101 s | 0 |

- Champion vs heuristic: **+11.2%**, 12 wins / 0 losses (per-episode +1.5% … +20.8%).
- Champion vs fixed-time: **+22.4%**, 10 wins / 2 losses (per-episode −6.1% … +46.8%).
- Heuristic vs fixed-time: +12.6%, 8 wins / 4 losses.

**3 vs 6 agents:**

| | 3 agents | 6 agents |
|---|---|---|
| First champion | round 2 | round 1 |
| Champions found | 2 | 4 |
| Development score | 30.57 | 28.66 |
| Parallel speedup | 1.8× | 3.2× |
| Held-out vs heuristic | +10.9% | +11.2% |

**Caveat to say aloud:** the larger development gain only partly carried over to unseen traffic, which is why the held-out suite is the number we report. Each run has its own held-out suite, so compare percentages, not raw scores, across runs.

## Control experiment: do the LLM agents matter? (`npm run ablation -- --run run-20261011-164124`)

This uses the same loop and the same budget (6 proposers × 6 rounds = 36 candidates), with the same scenarios, selection rule, and the **same 12 held-out episodes**. The only difference is the proposer: random perturbations of the champion instead of LLM agents. Results are in `experiments/ablations/ablation-run-20261011-164124.json`.

| Proposer | Held-out s/veh | vs heuristic | Wins / losses vs heuristic |
|---|---|---|---|
| Heuristic baseline | 31.80 | – | – |
| Random search, seed 0 | 30.95 | +2.7% | 7 / 5 |
| Random search, seed 1 | 30.01 | +5.6% | 9 / 3 |
| Random search, seed 2 | 30.30 | +4.7% | 10 / 2 |
| **LLM agents (DeepSeek on Luminal)** | **28.24** | **+11.2%** | **12 / 0 (sign test p = 0.0005)** |

On the same budget, the LLM agents gain about 2.6× more than random search (+11.2% vs a mean of +4.3%). Head to head on paired held-out episodes, the LLM champion beats each random-search champion by 8.8%, 5.9% and 6.8%, winning 11/12, 10/12 and 9/12 episodes (sign-test p = 0.006, 0.039 and 0.15).

### What the champion changed (vs the heuristic it started from)

- **Platoon anticipation:** the weight on moving vehicles approaching a green rose from 0.8 to **2.5 at both Atherton intersections** and to **1.8 elsewhere**. Green is held for arriving platoons instead of being cut as soon as the standing queue clears.
- **Coordinated green waves:** a 95 s coordination cycle with avenue-phase windows. College Ave runs westbound with offsets C_PUG 45 s → C_ALL 59 s → C_ATH 0 s; Beaver Ave runs eastbound with offsets B_ATH 0 s → B_ALL 36 s → B_PUG 50 s.
- **Rebalanced max greens:**
  - Atherton cross-street phase: 35 → 40 s (College & Atherton) and 35 → 45 s (Beaver & Atherton).
  - Beaver Ave phase capped lower: 50 → 45 s at Atherton and 50 → 40 s at Allen and Pugh.
  - Allen and Pugh cross phases: 35 → 45 s.
- **Fairness:** the oldest-wait weight rose from 0.04 to 0.06 everywhere. Side-street P95 improved from 107 s to 101 s.

Each change traces to an accepted proposal in the lineage: corridor green wave (R1), then platoon anticipation (R3), then more platoon weight at Atherton (R4), then Atherton alignment (R5).
