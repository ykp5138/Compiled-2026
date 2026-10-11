// Deterministic lane-based traffic simulator.
//
// Model summary (see docs/SIMULATION.md):
// - Fixed timestep, FIFO lanes with finite storage (7.5 m jam spacing).
// - Simple car following: accelerate toward link speed, never closer than jam spacing to the leader,
//   never past the stop line unless the movement is permitted and the receiving lane has room.
// - Saturation headway of 2 s per lane at the stop line (≈1800 veh/h/lane).
// - Blocked arrivals wait in an external entry queue (counted in all metrics).
// - Vehicles leave only at the end of their route's exit link.
// - Signals: the simulator owns min green, max green, yellow, all-red and anti-starvation.
//   Controllers only *request* a phase each step.
import { JAM_SPACING, movementsConflict, type Network } from "./network";
import type { Scenario } from "./scenarios";

export const SIMULATOR_VERSION = "1.0.0";

export const SIM = {
  dt: 0.5,
  /** Simulator minimum green: assumed pedestrian walk + clearance for downtown crossings. */
  minGreen: 10,
  /** Stopped vehicles cannot start through the stop line until this long into the green. */
  startupLostTime: 2,
  maxGreen: 60,
  yellow: 3,
  allRed: 2,
  /** A phase with waiting demand is force-served after this long without green. */
  maxRedWait: 90,
  satHeadway: 2.0,
  accel: 2.0,
  decel: 3.0,
  /** A vehicle is "stopped" when its speed is below this threshold (m/s). */
  stoppedSpeed: 0.5,
  /** Moving vehicles within this distance of the stop line count as "approaching". */
  approachWindow: 120,
  /** Link counts as spilled back when occupancy is at least this fraction of storage. */
  spillbackOccupancy: 0.9,
} as const;

export const CLEARANCE = SIM.yellow + SIM.allRed;

export type SignalStateCode = 0 | 1 | 2; // 0 green, 1 yellow, 2 all-red

export interface SignalObs {
  phase: number;
  state: SignalStateCode;
  stateElapsed: number;
  greenElapsed: number;
  nextPhase: number;
}

export interface PhaseObs {
  /** Stopped vehicles (incl. external entry queue) wanting a movement in this phase. */
  queue: number;
  /** Moving vehicles within the approach window wanting this phase. */
  approaching: number;
  /** Longest current stop time (s) among vehicles waiting for this phase on its approaches. */
  oldestWait: number;
  /** Highest occupancy fraction (0..1) among receiving links of this phase. */
  downstreamOcc: number;
  /** Seconds since this phase last showed green (0 while green). */
  sinceGreen: number;
}

/** Everything a controller may see: present-state detector aggregates only. */
export interface Observation {
  t: number;
  signals: SignalObs[];
  phases: PhaseObs[][];
}

export interface Controller {
  name: string;
  /** Returns the requested phase index per intersection. */
  decide(obs: Observation): number[];
}

interface Veh {
  id: number;
  route: number[];
  ri: number;
  lane: number;
  pos: number;
  v: number;
  sched: number;
  enteredAt: number;
  wait: number;
  waitLink: number;
  done: boolean;
  doneAt: number;
  moved: number;
  side: boolean;
}

interface Lane {
  vehs: Veh[];
  lastDischarge: number;
  lastEntry: number;
}

interface LinkStats {
  stoppedVehSec: number;
  entered: number;
  spillbackSec: number;
  blockedSec: number;
}

export interface ApproachMetric {
  link: string;
  street: string;
  dir: string;
  intersection: string;
  vehicles: number;
  stoppedVehSec: number;
  meanWait: number;
  spillbackSec: number;
  blockedSec: number;
}

export interface EpisodeMetrics {
  scenarioId: string;
  scheduled: number;
  completed: number;
  completionFraction: number;
  inNetwork: number;
  externalBacklog: number;
  totalStoppedVehSec: number;
  externalStoppedVehSec: number;
  /** PRIMARY SCORE: total stopped vehicle-seconds / total scheduled vehicles. Lower is better. */
  score: number;
  p95Wait: number;
  maxWait: number;
  sideP95Wait: number;
  sideMeanWait: number;
  /** Mean travel time of completed trips only (completion-conditioned). */
  meanTravelTimeCompleted: number;
  totalSpillbackSec: number;
  approaches: ApproachMetric[];
  duration: number;
}

export interface Frame {
  t: number;
  /** Flat [id, link*4+lane, round(pos*10), stopped(0/1)] per vehicle in the network. */
  v: number[];
  /** Flat [phase, state] per intersection. */
  s: number[];
  /** External entry queue length per entry link (net.entries order). */
  e: number[];
  /** Live partial metrics: [stoppedVehSec, released, completed, waitingNow, p95WaitSoFar]. */
  m: number[];
}

export interface Audit {
  redCrossings: number;
  yellowCrossings: number;
  conflictingGreens: number;
  capacityViolations: number;
  conservationErrors: number;
  minGreenViolations: number;
  clearanceViolations: number;
}

export interface RunOptions {
  record?: boolean;
  frameEvery?: number; // seconds
  audit?: boolean;
}

export interface RunResult {
  metrics: EpisodeMetrics;
  frames?: Frame[];
  audit?: Audit;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function runEpisode(net: Network, scenario: Scenario, controller: Controller, opts: RunOptions = {}): RunResult {
  const dt = SIM.dt;
  const links = net.links;
  const lanes: Lane[][] = links.map((l) =>
    Array.from({ length: l.lanes }, () => ({ vehs: [], lastDischarge: -Infinity, lastEntry: -Infinity })),
  );
  const stats: LinkStats[] = links.map(() => ({ stoppedVehSec: 0, entered: 0, spillbackSec: 0, blockedSec: 0 }));
  const external: Veh[][] = links.map(() => []);
  const sideOrigins = new Set(net.raw.demand.sideStreetOrigins.map((id) => net.linkById.get(id)!.idx));
  const all: Veh[] = scenario.arrivals.map((a) => ({
    id: a.id,
    route: a.route,
    ri: 0,
    lane: -1,
    pos: 0,
    v: 0,
    sched: a.t,
    enteredAt: -1,
    wait: 0,
    waitLink: 0,
    done: false,
    doneAt: -1,
    moved: -1,
    side: sideOrigins.has(a.origin),
  }));
  const arrivalOrder = [...all].sort((a, b) => a.sched - b.sched || a.id - b.id);
  let nextArrival = 0;

  const nI = net.intersections.length;
  const sig = net.intersections.map(() => ({ phase: 0, state: 0 as SignalStateCode, stateElapsed: 0, greenElapsed: 0, nextPhase: 0 }));
  const lastGreenAt: number[][] = net.intersections.map((i) => i.phases.map(() => 0));
  const yellowStart: number[] = net.intersections.map(() => -Infinity);

  const audit: Audit = {
    redCrossings: 0,
    yellowCrossings: 0,
    conflictingGreens: 0,
    capacityViolations: 0,
    conservationErrors: 0,
    minGreenViolations: 0,
    clearanceViolations: 0,
  };

  const totalStorage = links.map((l) => l.storagePerLane * l.lanes);
  const linkCount = (li: number) => {
    let c = 0;
    for (const ln of lanes[li]) c += ln.vehs.length;
    return c;
  };

  const phaseObs: PhaseObs[][] = net.intersections.map((i) =>
    i.phases.map(() => ({ queue: 0, approaching: 0, oldestWait: 0, downstreamOcc: 0, sinceGreen: 0 })),
  );

  function observe(t: number): Observation {
    for (let ii = 0; ii < nI; ii++) {
      const inter = net.intersections[ii];
      for (let p = 0; p < inter.phases.length; p++) {
        const po = phaseObs[ii][p];
        po.queue = 0;
        po.approaching = 0;
        po.oldestWait = 0;
        let occ = 0;
        for (const mi of inter.phases[p].movements) {
          const to = net.movements[mi].to;
          occ = Math.max(occ, linkCount(to) / Math.max(1, totalStorage[to]));
        }
        po.downstreamOcc = occ;
        const s = sig[ii];
        po.sinceGreen = s.state === 0 && s.phase === p ? 0 : t - lastGreenAt[ii][p];
      }
      for (const li of inter.approaches) {
        const L = links[li].length;
        for (const ln of lanes[li]) {
          for (const veh of ln.vehs) {
            const m = net.movementByPair.get(`${li}>${veh.route[veh.ri + 1]}`)!;
            const p = inter.phaseOfMovement.get(m.idx)!;
            const po = phaseObs[ii][p];
            if (veh.v < SIM.stoppedSpeed) {
              po.queue++;
              if (veh.waitLink > po.oldestWait) po.oldestWait = veh.waitLink;
            } else if (L - veh.pos <= SIM.approachWindow) {
              po.approaching++;
            }
          }
        }
        for (const veh of external[li]) {
          const m = net.movementByPair.get(`${li}>${veh.route[1]}`)!;
          const p = inter.phaseOfMovement.get(m.idx)!;
          const po = phaseObs[ii][p];
          po.queue++;
          if (veh.wait > po.oldestWait) po.oldestWait = veh.wait;
        }
      }
    }
    return {
      t,
      signals: sig.map((s) => ({ ...s })),
      phases: phaseObs.map((ps) => ps.map((p) => ({ ...p }))),
    };
  }

  function updateSignals(t: number, req: number[], obs: Observation) {
    for (let ii = 0; ii < nI; ii++) {
      const s = sig[ii];
      const nP = net.intersections[ii].phases.length;
      s.stateElapsed += dt;
      if (s.state === 0) s.greenElapsed += dt;
      if (s.state === 0) {
        const demand = (p: number) => obs.phases[ii][p].queue + obs.phases[ii][p].approaching > 0;
        let target = -1;
        // Anti-starvation (simulator-owned): serve a long-waiting phase once min green is met.
        if (s.greenElapsed >= SIM.minGreen) {
          let best = -1;
          for (let p = 0; p < nP; p++) {
            if (p === s.phase || !demand(p)) continue;
            if (obs.phases[ii][p].sinceGreen >= SIM.maxRedWait && (best < 0 || obs.phases[ii][p].sinceGreen > obs.phases[ii][best].sinceGreen)) best = p;
          }
          if (best >= 0) target = best;
        }
        // Max green (simulator-owned).
        if (target < 0 && s.greenElapsed >= SIM.maxGreen) {
          let best = -1;
          for (let p = 0; p < nP; p++) {
            if (p === s.phase || !demand(p)) continue;
            if (best < 0 || obs.phases[ii][p].sinceGreen > obs.phases[ii][best].sinceGreen) best = p;
          }
          if (best >= 0) target = best;
        }
        // Controller request, honoured only after min green.
        const r = req[ii];
        if (target < 0 && Number.isInteger(r) && r >= 0 && r < nP && r !== s.phase && s.greenElapsed >= SIM.minGreen) target = r;
        if (target >= 0) {
          if (s.greenElapsed < SIM.minGreen) audit.minGreenViolations++;
          s.state = 1;
          s.stateElapsed = 0;
          s.nextPhase = target;
          lastGreenAt[ii][s.phase] = t;
          yellowStart[ii] = t;
        }
      } else if (s.state === 1) {
        if (s.stateElapsed >= SIM.yellow - 1e-9) {
          s.state = 2;
          s.stateElapsed = 0;
        }
      } else if (s.stateElapsed >= SIM.allRed - 1e-9) {
        if (t - yellowStart[ii] < CLEARANCE - 1e-9) audit.clearanceViolations++;
        s.state = 0;
        s.stateElapsed = 0;
        s.greenElapsed = 0;
        s.phase = s.nextPhase;
      }
    }
  }

  function permitted(mi: number, gap: number, v: number): 0 | 1 | 2 {
    const m = net.movements[mi];
    const s = sig[m.intersection];
    const inPhase = net.intersections[m.intersection].phaseOfMovement.get(mi) === s.phase;
    if (!inPhase) return 0;
    if (s.state === 0) return v < SIM.stoppedSpeed && s.greenElapsed < SIM.startupLostTime ? 0 : 1;
    // Yellow: only vehicles that cannot stop comfortably may continue (dilemma zone).
    if (s.state === 1 && v > SIM.stoppedSpeed && gap < (v * v) / (2 * SIM.decel)) return 2;
    return 0;
  }

  function pickLane(li: number, nextLink: number | undefined): number {
    const link = links[li];
    let best = -1;
    let bestCount = Infinity;
    for (let k = 0; k < link.lanes; k++) {
      if (nextLink !== undefined && link.kind !== "exit" && !link.laneNext[k].includes(nextLink)) continue;
      const ln = lanes[li][k];
      const n = ln.vehs.length;
      if (n >= link.storagePerLane) continue;
      if (n > 0 && ln.vehs[n - 1].pos < JAM_SPACING) continue;
      if (n < bestCount) {
        best = k;
        bestCount = n;
      }
    }
    return best;
  }

  let completed = 0;
  let stoppedTotal = 0;
  let externalStopped = 0;
  let released = 0;
  let step = 0;
  const endT = scenario.horizon + scenario.drain;
  const nSteps = Math.round(endT / dt);
  const frames: Frame[] = [];
  const frameEverySteps = Math.max(1, Math.round((opts.frameEvery ?? 1) / dt));

  function liveP95(): number {
    const w: number[] = [];
    for (let i = 0; i < nextArrival; i++) w.push(arrivalOrder[i].wait);
    w.sort((a, b) => a - b);
    return percentile(w, 0.95);
  }

  function recordFrame(t: number) {
    const v: number[] = [];
    let waitingNow = 0;
    for (let li = 0; li < links.length; li++) {
      for (let k = 0; k < lanes[li].length; k++) {
        for (const veh of lanes[li][k].vehs) {
          const stopped = veh.v < SIM.stoppedSpeed ? 1 : 0;
          waitingNow += stopped;
          v.push(veh.id, li * 4 + k, Math.round(veh.pos * 10), stopped);
        }
      }
    }
    const e = net.entries.map((li) => external[li].length);
    for (const n of e) waitingNow += n;
    frames.push({
      t,
      v,
      s: sig.flatMap((s) => [s.phase, s.state]),
      e,
      m: [Math.round(stoppedTotal), released, completed, waitingNow, liveP95()],
    });
  }

  // Initialise signals from the controller's first request (no vehicles yet).
  {
    const obs0 = observe(0);
    const req0 = controller.decide(obs0);
    for (let ii = 0; ii < nI; ii++) {
      const r = req0[ii];
      const nP = net.intersections[ii].phases.length;
      sig[ii].phase = Number.isInteger(r) && r >= 0 && r < nP ? r : 0;
      sig[ii].greenElapsed = SIM.minGreen;
    }
  }
  if (opts.record) recordFrame(0);

  for (step = 0; step < nSteps; step++) {
    const t = step * dt;

    // 1. Release scheduled arrivals into external entry queues.
    while (nextArrival < arrivalOrder.length && arrivalOrder[nextArrival].sched <= t + 1e-9) {
      const veh = arrivalOrder[nextArrival++];
      external[veh.route[0]].push(veh);
      released++;
    }

    // 2. Controller request -> simulator-enforced signal update.
    const obs = observe(t);
    const req = controller.decide(obs);
    updateSignals(t, req, obs);
    if (opts.audit) {
      // Green movements at any intersection must all belong to the active phase.
      for (let ii = 0; ii < nI; ii++) {
        if (sig[ii].state !== 0) continue;
        const green = net.intersections[ii].phases[sig[ii].phase].movements;
        for (const a of green) for (const b of green) {
          if (a < b && movementsConflict(net, net.movements[a], net.movements[b])) audit.conflictingGreens++;
        }
      }
    }

    // 3. Move vehicles lane by lane (front to back).
    for (let li = 0; li < links.length; li++) {
      const link = links[li];
      const L = link.length;
      for (let k = 0; k < link.lanes; k++) {
        const ln = lanes[li][k];
        let i = 0;
        while (i < ln.vehs.length) {
          const veh = ln.vehs[i];
          if (veh.moved === step) {
            i++;
            continue;
          }
          let limit: number;
          let gateLane = -1;
          let isExit = false;
          let crossing: 0 | 1 | 2 = 0;
          if (i === 0) {
            if (link.kind === "exit") {
              isExit = true;
              limit = Infinity;
            } else {
              const next = veh.route[veh.ri + 1];
              const m = net.movementByPair.get(`${li}>${next}`)!;
              crossing = permitted(m.idx, L - veh.pos, veh.v);
              const headwayOk = t - ln.lastDischarge >= SIM.satHeadway - 1e-9;
              if (crossing && headwayOk) {
                gateLane = pickLane(next, veh.route[veh.ri + 2]);
                if (gateLane < 0 && L - veh.pos < 1) stats[li].blockedSec += dt;
              }
              limit = gateLane >= 0 ? Infinity : L;
            }
          } else {
            limit = ln.vehs[i - 1].pos - JAM_SPACING;
          }
          const gap = limit - veh.pos;
          let vNew = Math.min(link.speed, veh.v + SIM.accel * dt);
          if (gap !== Infinity) {
            vNew = Math.min(vNew, Math.sqrt(2 * SIM.decel * Math.max(0, gap)), Math.max(0, gap) / dt);
          }
          veh.v = Math.max(0, vNew);
          veh.pos += veh.v * dt;
          veh.moved = step;
          if (i === 0 && veh.pos >= L - 1e-9 && (isExit || gateLane >= 0)) {
            ln.vehs.shift();
            if (isExit) {
              veh.done = true;
              veh.doneAt = t + dt;
              completed++;
            } else {
              if (opts.audit) {
                const m = net.movementByPair.get(`${li}>${veh.route[veh.ri + 1]}`)!;
                const s = sig[m.intersection];
                const inPhase = net.intersections[m.intersection].phaseOfMovement.get(m.idx) === s.phase;
                if (!inPhase || s.state === 2) audit.redCrossings++;
                else if (s.state === 1) audit.yellowCrossings++;
              }
              ln.lastDischarge = t;
              const next = veh.route[veh.ri + 1];
              const target = lanes[next][gateLane];
              const tail = target.vehs[target.vehs.length - 1];
              const over = veh.pos - L;
              veh.pos = tail ? Math.min(over, tail.pos - JAM_SPACING) : over;
              veh.v = Math.min(veh.v, links[next].speed);
              veh.ri++;
              veh.lane = gateLane;
              veh.waitLink = 0;
              target.vehs.push(veh);
              stats[next].entered++;
              if (opts.audit && target.vehs.length > links[next].storagePerLane) audit.capacityViolations++;
            }
            continue; // new front vehicle (if any) is evaluated with i = 0
          }
          i++;
        }
      }
    }

    // 4. Admit vehicles from external entry queues.
    for (const li of net.entries) {
      const q = external[li];
      while (q.length > 0) {
        const veh = q[0];
        const k = pickLane(li, veh.route[1]);
        if (k < 0 || t - lanes[li][k].lastEntry < SIM.satHeadway - 1e-9) break;
        q.shift();
        const ln = lanes[li][k];
        ln.lastEntry = t;
        const tail = ln.vehs[ln.vehs.length - 1];
        veh.pos = 0;
        veh.lane = k;
        veh.enteredAt = t;
        veh.v = tail ? Math.min(links[li].speed * 0.6, Math.sqrt(2 * SIM.decel * Math.max(0, tail.pos - JAM_SPACING))) : links[li].speed * 0.6;
        veh.moved = step;
        ln.vehs.push(veh);
        stats[li].entered++;
      }
    }

    // 5. Accumulate stopped time and spillback.
    for (let li = 0; li < links.length; li++) {
      let count = 0;
      for (const ln of lanes[li]) {
        count += ln.vehs.length;
        for (const veh of ln.vehs) {
          if (veh.v < SIM.stoppedSpeed) {
            veh.wait += dt;
            veh.waitLink += dt;
            stats[li].stoppedVehSec += dt;
            stoppedTotal += dt;
          }
        }
      }
      if (links[li].kind !== "exit" && count >= SIM.spillbackOccupancy * totalStorage[li]) stats[li].spillbackSec += dt;
      for (const veh of external[li]) {
        veh.wait += dt;
        stoppedTotal += dt;
        externalStopped += dt;
      }
    }

    if (opts.audit) {
      let inNet = 0;
      let ext = 0;
      for (let li = 0; li < links.length; li++) {
        inNet += linkCount(li);
        ext += external[li].length;
      }
      if (inNet + ext + completed !== released) audit.conservationErrors++;
    }

    if (opts.record && (step + 1) % frameEverySteps === 0) recordFrame((step + 1) * dt);
  }

  // Final metrics.
  let inNetwork = 0;
  let externalBacklog = 0;
  for (let li = 0; li < links.length; li++) {
    inNetwork += linkCount(li);
    externalBacklog += external[li].length;
  }
  const waits = all.map((v) => v.wait).sort((a, b) => a - b);
  const sideWaits = all.filter((v) => v.side).map((v) => v.wait).sort((a, b) => a - b);
  const done = all.filter((v) => v.done);
  const scheduled = all.length;
  const approaches: ApproachMetric[] = [];
  for (const inter of net.intersections) {
    for (const li of inter.approaches) {
      const l = links[li];
      approaches.push({
        link: l.id,
        street: l.street,
        dir: l.dir,
        intersection: inter.id,
        vehicles: stats[li].entered,
        stoppedVehSec: stats[li].stoppedVehSec,
        meanWait: stats[li].entered > 0 ? stats[li].stoppedVehSec / stats[li].entered : 0,
        spillbackSec: stats[li].spillbackSec,
        blockedSec: stats[li].blockedSec,
      });
    }
  }
  const metrics: EpisodeMetrics = {
    scenarioId: scenario.id,
    scheduled,
    completed,
    completionFraction: scheduled > 0 ? completed / scheduled : 1,
    inNetwork,
    externalBacklog,
    totalStoppedVehSec: stoppedTotal,
    externalStoppedVehSec: externalStopped,
    score: scheduled > 0 ? stoppedTotal / scheduled : 0,
    p95Wait: percentile(waits, 0.95),
    maxWait: waits.length ? waits[waits.length - 1] : 0,
    sideP95Wait: percentile(sideWaits, 0.95),
    sideMeanWait: sideWaits.length ? sideWaits.reduce((a, b) => a + b, 0) / sideWaits.length : 0,
    meanTravelTimeCompleted: done.length ? done.reduce((a, v) => a + (v.doneAt - v.sched), 0) / done.length : 0,
    totalSpillbackSec: stats.reduce((a, s) => a + s.spillbackSec, 0),
    approaches,
    duration: endT,
  };
  return { metrics, frames: opts.record ? frames : undefined, audit: opts.audit ? audit : undefined };
}
