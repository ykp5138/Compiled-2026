# Simulation assumptions, score and evaluation protocol

Everything here describes a **simplified, synthetic** model. It is not calibrated to measured State College traffic and the signal timings are not municipal timing plans.

## Network (`sim/network.json`)

| Item | Model |
|---|---|
| Streets | College Ave (one-way **westbound**, 2 lanes), Beaver Ave (one-way **eastbound**, 2 lanes, south of College), Atherton St (two-way, 2 lanes each way), Allen St and Pugh St (two-way, 1 lane each way). |
| Signals | 6: College & {Atherton, Allen, Pugh}, Beaver & {Atherton, Allen, Pugh}. |
| Geometry | Axis-aligned schematic in metres, north up. The real grid is rotated about 45°; block lengths are approximate (Atherton→Allen 400 m, Allen→Pugh 160 m, College→Beaver 140 m). |
| Omitted | Intermediate streets (Burrowes, Fraser, Garner, …), driveways, parking, transit, bikes and pedestrians as agents. |
| Campus | Allen and Pugh end at College Ave; campus (with an approximate Old Main) is drawn for context only, with no vehicle roads. |

To change the network, edit `sim/network.json`. Links, lanes, movements, phases, conflict checks and routes are all derived from it, and the loader rejects phases that contain conflicting movements.

### Movements and phases
Every intersection has two phases: the avenue (College WB or Beaver EB) and the cross street.

| Intersection | Avenue phase | Cross-street phase |
|---|---|---|
| College & Atherton | College WB through / left (to Atherton SB) / right (to Atherton NB) | Atherton SB through + right (to College WB), Atherton NB through |
| College & Allen, College & Pugh | College WB through / left (onto the side street SB) | Side street NB left onto College WB |
| Beaver & Atherton | Beaver EB through / left (NB) / right (SB) | Atherton NB through + right (to Beaver EB), Atherton SB through |
| Beaver & Allen, Beaver & Pugh | Beaver EB through / left / right | Side street NB through + right, side street SB through |

**Intentional omissions.** Left turns from Atherton onto the avenues, and left turns from Allen/Pugh southbound onto Beaver, would need permissive or protected-left logic, so they are excluded. There are no permissive turns, no lane changes after a vehicle enters a link, and no U-turns.

### Lanes
- Multi-lane links: the leftmost lane carries through and left; the rightmost carries through and right.
- Single-lane links carry every movement.
- A vehicle picks the least-occupied legal lane when it enters a link.

## Vehicle model (`sim/simulator.ts`)
- **Timestep:** fixed at 0.5 s. Demand horizon 900 s plus a 300 s drain period (configurable) for every controller.
- **Storage:** each lane is a FIFO queue holding `floor(length / 7.5 m)` vehicles.
- **Car following:**
  - Speed is the minimum of the link speed (11.2 m/s on the avenues, 13.4 on Atherton, 8.9 on Allen/Pugh), `v + 2 m/s²·dt`, and the safe-stopping speed `sqrt(2·3 m/s²·gap)`.
  - The gap is to the leader minus 7.5 m, or to the stop line.
- **Crossing the stop line:** the lead vehicle may cross only when all of these hold:
  1. its movement is in the active phase and the signal is green, or yellow and the vehicle cannot stop comfortably (dilemma zone);
  2. at least 2 s has passed since the lane's last discharge (saturation headway, about 1800 veh/h/lane);
  3. a stopped vehicle has waited out the 2 s start-up lost time;
  4. a lane on the receiving link has space.
- **Spillback:** a full receiving link holds vehicles at the stop line ("blocked by downstream"), and queues propagate upstream.
- **Entry queues:** arrivals that cannot enter the map wait in an **external entry queue** and accrue stopped time.
- **Exits:** vehicles leave only at the end of their route's exit link. There are no other deletions.

## Signals (simulator-owned, policies cannot override)

| Rule | Value |
|---|---|
| Minimum green | 10 s (assumed pedestrian walk + clearance) |
| Maximum green | 60 s (forced switch if another phase has demand) |
| Yellow / all-red | 3 s / 2 s |
| Anti-starvation | A phase with waiting demand is served after 90 s without green (once min green is met) |
| Start-up lost time | 2 s |

Controllers return only a *requested* phase per intersection every step.

## Demand (`sim/scenarios.ts`)
**Base rates (veh/h):**

| Approach | Rate |
|---|---|
| College in (east) | 1550 |
| Beaver in (west) | 1550 |
| Atherton N | 1200 |
| Atherton S | 1200 |
| Allen | 360 |
| Pugh | 300 |

Destination shares are in `network.json`. Each scenario's arrival schedule (time, origin, destination, route) is generated **before** any controller runs, from a seed hashed with the suite name. Every controller is replayed on byte-identical arrivals, and a checksum is stored per scenario.

| Type | Pattern |
|---|---|
| balanced | base rates |
| arterial | College/Beaver ×1.25, Atherton ×0.9, Allen/Pugh ×0.8 |
| side | College/Beaver ×0.85, Atherton ×1.1, Allen/Pugh ×2.2 |
| bursty | ×0.85 base plus three 60–100 s pulses (×2.2–3.0) on random approaches |
| shift | arterial-heavy first half, side-street-heavy second half |

Each scenario also applies a seeded ±8% global and ±10% per-approach jitter.

## Score
**Primary score** = total stopped vehicle-seconds ÷ total scheduled vehicles (lower is better).
- *Stopped* means speed < 0.5 m/s inside the network, plus **all** time spent in an external entry queue.
- Unfinished vehicles keep accruing stopped time until the end of the drain period and are reported as residual backlog.

**Also reported:**
- Completed trips and completion fraction.
- Vehicles remaining in the network and external backlog.
- P95 and max observed wait, including unfinished vehicles.
- Side-street (Allen/Pugh origin) P95 wait.
- Mean travel time of **completed** trips (completion-conditioned).
- Per-approach mean wait, spillback seconds (occupancy ≥ 90%) and blocked-by-downstream seconds.

**Relative improvement** = `100 × (baseline − candidate) / baseline`. If both scores are zero it is 0; if only the baseline is zero it is reported as n/a. Comparisons are paired by scenario ID and report wins, losses, and the per-episode mean ± sd and range.

## Baselines (calibrated on training demand only)
1. **Fixed-time.**
   - Webster cycle and critical-lane-ratio splits come from training flows, with progression offsets along College (WB) and Beaver (EB).
   - A grid search on the training suite covers cycle 40–120 s, progression vs zero offsets, and a ×1.3 cross-street split.
   - Plans that cannot give every phase its minimum green are skipped.
2. **Queue-responsive heuristic.**
   - It serves the phase with the most stopped + approaching vehicles, plus a small oldest-wait term, discounted by receiving-link occupancy.
   - A grid search on the training suite covers min hold, hysteresis and approaching weight.

Both baselines are expressed in the same policy schema the agents use.

## Policy schema (`sim/policy.ts`)
Agents return declarative JSON, never code. Per intersection the policy has:
- `mode`: `fixed` or `adaptive`.
- A fixed plan: cycle, splits, offset.
- Adaptive parameters: min hold, per-phase max green, weights for queue / approaching / oldest wait / downstream occupancy, phase bias, hysteresis.
- Optional coordination windows: a shared cycle, with per-intersection phase bonuses during an offset window.

The validator checks all bounds, IDs, phase references, and that fixed greens respect simulator limits. The interpreter is deterministic and sees only present detector aggregates.

## Evaluation protocol
| Suite | Size | Use |
|---|---|---|
| Training | 8 episodes | Agents see these metrics; candidates are screened here. |
| Development | 4 episodes | Used repeatedly for the selection rule. **Not** unseen data. |
| Held-out | 12 episodes | Generated only after the champion is frozen (`server/heldout.ts`); seeds derived from the run ID; never in agent context. After freezing, the run cannot be optimized further. A new experiment gets a new held-out suite. |

### Selection rule
1. The candidate must be valid.
2. Its training score must beat the champion's training score.
3. On development it must:
   - improve the score by ≥ 1%;
   - win ≥ 50% of paired episodes;
   - lose no more than 0.5 percentage points of completion;
   - keep side-street P95 ≤ champion × 1.1 + 2 s;
   - keep overall P95 ≤ champion × 1.1 + 2 s.
4. If several candidates pass in a round, the best development score wins.

The starting champion is the stronger baseline on the development suite.
