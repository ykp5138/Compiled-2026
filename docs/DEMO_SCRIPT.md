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
