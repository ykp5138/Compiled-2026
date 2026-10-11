# Two-minute demo script

Setup before presenting: `npm run build && npm start`, open http://localhost:8787. The recorded run is selected in the run dropdown and shows the **Recorded run** badge. Default scenario: `dev-bursty-2003`. Default maps: fixed-time on the left, current champion on the right.

**0:00–0:20 · Problem and baseline**
- "GreenWave State College: three AI agents improve traffic-signal policies for six downtown signals: College, Beaver, Atherton, Allen, Pugh."
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
