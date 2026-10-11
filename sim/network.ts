// Network loading and derivation: links, lanes, movements, phases, conflicts and routes.
// The editable source of truth is network.json; everything here is derived deterministically.
import rawNetwork from "./network.json";
import manhattanNetwork from "./networks/manhattan-east-village.json";

export type Turn = "T" | "L" | "R";
export type LinkKind = "entry" | "internal" | "exit";

export interface RawNetwork {
  id?: string;
  name: string;
  /** Plain-language description given to the agents (first lines of the NETWORK section). */
  description?: string[];
  disclaimer: string;
  notes: string[];
  laneWidth: number;
  intersectionInset: number;
  nodes: { id: string; kind: "signal" | "boundary"; x: number; y: number; name?: string }[];
  links: { id: string; from: string; to: string; street: string; dir: string; lanes: number; speed: number }[];
  intersections: { id: string; movements: [string, string, string][]; phases: { name: string; movements: string[] }[] }[];
  demand: {
    baseVehPerHour: Record<string, number>;
    sideStreetOrigins: string[];
    arterialOrigins: string[];
    crossArterialOrigins: string[];
    destinationShares: Record<string, Record<string, number>>;
  };
  map: {
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    campus?: { x0: number; y0: number; x1: number; y1: number; label: string };
    /** Extra labelled context areas (parks, campuses). */
    areas?: { x0: number; y0: number; x1: number; y1: number; label: string; kind?: string }[];
    landmarks?: { label: string; x: number; y: number; w: number; h: number }[];
    downtownLabel?: { text: string; x: number; y: number };
    streetLabels: { text: string; x: number; y: number; angle: number }[];
  };
}

export interface Link {
  id: string;
  idx: number;
  from: string;
  to: string;
  street: string;
  dir: string;
  lanes: number;
  speed: number;
  /** Driveable length between stop line / boundary, metres. */
  length: number;
  /** Vehicle storage per lane (jam spacing). */
  storagePerLane: number;
  kind: LinkKind;
  /** Intersection index this link feeds (approach), or -1 for exit links. */
  toIntersection: number;
  twoWay: boolean;
  /** World coordinates of the driveable segment start/end on the centreline. */
  x0: number; y0: number; x1: number; y1: number;
  ux: number; uy: number;
  /** For each lane: indices of links reachable from this lane (empty array on exit links = any). */
  laneNext: number[][];
}

export interface Movement {
  id: string;
  idx: number;
  intersection: number;
  from: number;
  to: number;
  turn: Turn;
}

export interface Phase {
  name: string;
  movements: number[];
}

export interface Intersection {
  id: string;
  idx: number;
  name: string;
  x: number;
  y: number;
  movements: number[];
  phases: Phase[];
  /** Approach link indices. */
  approaches: number[];
  /** phaseOfMovement[movementIdx] -> phase index, for movements at this intersection. */
  phaseOfMovement: Map<number, number>;
}

export interface Network {
  raw: RawNetwork;
  links: Link[];
  linkById: Map<string, Link>;
  movements: Movement[];
  /** key `${fromIdx}>${toIdx}` -> movement */
  movementByPair: Map<string, Movement>;
  intersections: Intersection[];
  intersectionById: Map<string, Intersection>;
  entries: number[];
  exits: number[];
  /** routes.get(`${entryIdx}>${exitIdx}`) -> link index path (entry ... exit) */
  routes: Map<string, number[]>;
}

export const JAM_SPACING = 7.5; // metres per stored vehicle

function headingName(ux: number, uy: number): string {
  if (Math.abs(ux) > Math.abs(uy)) return ux > 0 ? "E" : "W";
  return uy > 0 ? "S" : "N";
}

/** Two movements conflict if their paths cross or merge. Conservative geometric rule. */
export function movementsConflict(net: Network, a: Movement, b: Movement): boolean {
  if (a.intersection !== b.intersection) return false;
  if (a.from === b.from) return false; // same approach, lane-separated
  if (a.to === b.to) return true; // merge into the same receiving link
  const la = net.links[a.from];
  const lb = net.links[b.from];
  const dot = la.ux * lb.ux + la.uy * lb.uy;
  if (Math.abs(dot) < 0.5) return true; // perpendicular approaches cross
  if (dot < -0.5) return a.turn === "L" || b.turn === "L"; // opposing: left turns cross
  return false;
}

export function buildNetwork(raw: RawNetwork = rawNetwork as unknown as RawNetwork): Network {
  const nodeById = new Map(raw.nodes.map((n) => [n.id, n]));
  const signalIds = raw.intersections.map((i) => i.id);
  const inset = raw.intersectionInset;

  const links: Link[] = raw.links.map((l, idx) => {
    const a = nodeById.get(l.from);
    const b = nodeById.get(l.to);
    if (!a || !b) throw new Error(`Link ${l.id} references unknown node`);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const ux = dx / d;
    const uy = dy / d;
    const startInset = a.kind === "signal" ? inset : 0;
    const endInset = b.kind === "signal" ? inset : 0;
    const length = d - startInset - endInset;
    const kind: LinkKind = a.kind === "boundary" ? "entry" : b.kind === "boundary" ? "exit" : "internal";
    return {
      id: l.id,
      idx,
      from: l.from,
      to: l.to,
      street: l.street,
      dir: l.dir,
      lanes: l.lanes,
      speed: l.speed,
      length,
      storagePerLane: Math.floor(length / JAM_SPACING),
      kind,
      toIntersection: b.kind === "signal" ? signalIds.indexOf(b.id) : -1,
      twoWay: raw.links.some((o) => o.from === l.to && o.to === l.from),
      x0: a.x + ux * startInset,
      y0: a.y + uy * startInset,
      x1: b.x - ux * endInset,
      y1: b.y - uy * endInset,
      ux,
      uy,
      laneNext: [],
    };
  });
  const linkById = new Map(links.map((l) => [l.id, l]));
  const getLink = (id: string) => {
    const l = linkById.get(id);
    if (!l) throw new Error(`Unknown link ${id}`);
    return l;
  };

  const movements: Movement[] = [];
  const movementByPair = new Map<string, Movement>();
  const intersections: Intersection[] = raw.intersections.map((ri, iIdx) => {
    const node = nodeById.get(ri.id);
    if (!node || node.kind !== "signal") throw new Error(`Intersection ${ri.id} has no signal node`);
    const mIdxs: number[] = [];
    const idByName = new Map<string, number>();
    for (const [from, to, turn] of ri.movements) {
      const fl = getLink(from);
      const tl = getLink(to);
      if (fl.to !== ri.id || tl.from !== ri.id) throw new Error(`Movement ${from}>${to} does not pass through ${ri.id}`);
      const m: Movement = { id: `${from}>${to}`, idx: movements.length, intersection: iIdx, from: fl.idx, to: tl.idx, turn: turn as Turn };
      movements.push(m);
      movementByPair.set(`${fl.idx}>${tl.idx}`, m);
      mIdxs.push(m.idx);
      idByName.set(m.id, m.idx);
    }
    const phaseOfMovement = new Map<number, number>();
    const phases: Phase[] = ri.phases.map((p, pIdx) => ({
      name: p.name,
      movements: p.movements.map((mid) => {
        const idx = idByName.get(mid);
        if (idx === undefined) throw new Error(`Phase ${p.name} at ${ri.id} references unknown movement ${mid}`);
        if (phaseOfMovement.has(idx)) throw new Error(`Movement ${mid} appears in two phases at ${ri.id}`);
        phaseOfMovement.set(idx, pIdx);
        return idx;
      }),
    }));
    for (const mi of mIdxs) {
      if (!phaseOfMovement.has(mi)) throw new Error(`Movement ${movements[mi].id} at ${ri.id} is in no phase`);
    }
    const approaches = [...new Set(mIdxs.map((mi) => movements[mi].from))];
    return { id: ri.id, idx: iIdx, name: node.name ?? ri.id, x: node.x, y: node.y, movements: mIdxs, phases, approaches, phaseOfMovement };
  });

  const net: Network = {
    raw,
    links,
    linkById,
    movements,
    movementByPair,
    intersections,
    intersectionById: new Map(intersections.map((i) => [i.id, i])),
    entries: links.filter((l) => l.kind === "entry").map((l) => l.idx),
    exits: links.filter((l) => l.kind === "exit").map((l) => l.idx),
    routes: new Map(),
  };

  // Phase safety: no conflicting movements may share a phase.
  for (const inter of intersections) {
    for (const p of inter.phases) {
      for (let i = 0; i < p.movements.length; i++) {
        for (let j = i + 1; j < p.movements.length; j++) {
          const a = movements[p.movements[i]];
          const b = movements[p.movements[j]];
          if (movementsConflict(net, a, b)) throw new Error(`Conflicting movements ${a.id} and ${b.id} share phase ${p.name}`);
        }
      }
    }
  }

  // Lane assignment: leftmost lane carries through + left, rightmost through + right, single lane carries all.
  for (const link of links) {
    const outs = movements.filter((m) => m.from === link.idx);
    if (link.kind === "exit") {
      link.laneNext = Array.from({ length: link.lanes }, () => []);
      continue;
    }
    if (outs.length === 0) throw new Error(`Link ${link.id} has no outgoing movement`);
    link.laneNext = Array.from({ length: link.lanes }, (_, lane) => {
      if (link.lanes === 1) return outs.map((m) => m.to);
      let allowed: Turn[] = ["T"];
      if (lane === 0) allowed = ["T", "L"];
      if (lane === link.lanes - 1) allowed = ["T", "R"];
      const ok = outs.filter((m) => allowed.includes(m.turn)).map((m) => m.to);
      return ok.length > 0 ? ok : outs.map((m) => m.to);
    });
    for (const m of outs) {
      if (!link.laneNext.some((ln) => ln.includes(m.to))) throw new Error(`No lane on ${link.id} serves ${m.id}`);
    }
  }

  // Routes: shortest path by length over legal movements (deterministic tie-breaking by link index).
  for (const entry of net.entries) {
    const dist = new Map<number, number>([[entry, 0]]);
    const prev = new Map<number, number>();
    const done = new Set<number>();
    for (;;) {
      let best = -1;
      let bestD = Infinity;
      for (const [k, d] of dist) {
        if (!done.has(k) && (d < bestD || (d === bestD && k < best))) {
          best = k;
          bestD = d;
        }
      }
      if (best < 0) break;
      done.add(best);
      for (const m of movements) {
        if (m.from !== best) continue;
        const nd = bestD + links[m.to].length;
        if (nd < (dist.get(m.to) ?? Infinity)) {
          dist.set(m.to, nd);
          prev.set(m.to, best);
        }
      }
    }
    for (const exit of net.exits) {
      if (!dist.has(exit)) continue;
      const path = [exit];
      while (path[0] !== entry) path.unshift(prev.get(path[0])!);
      net.routes.set(`${entry}>${exit}`, path);
    }
  }
  for (const [origin, shares] of Object.entries(raw.demand.destinationShares)) {
    const o = getLink(origin);
    for (const dest of Object.keys(shares)) {
      const d = getLink(dest);
      if (!net.routes.has(`${o.idx}>${d.idx}`)) throw new Error(`No legal route ${origin} -> ${dest}`);
    }
  }
  return net;
}

export function describeLink(l: Link): string {
  return `${l.street} ${l.dir} (${l.id})`;
}

export { headingName };

export const DEFAULT_NETWORK_ID = "state-college";

/** Registered networks. Each is an editable JSON file; experiments record which one they use. */
export const NETWORK_SOURCES: Record<string, RawNetwork> = {
  "state-college": { id: "state-college", ...(rawNetwork as unknown as RawNetwork) },
  "manhattan-east-village": manhattanNetwork as unknown as RawNetwork,
};

export function listNetworks(): { id: string; name: string; signals: number }[] {
  return Object.entries(NETWORK_SOURCES).map(([id, r]) => ({ id, name: r.name, signals: r.intersections.length }));
}

const cache = new Map<string, Network>();
export function getNetwork(id: string = DEFAULT_NETWORK_ID): Network {
  let n = cache.get(id);
  if (!n) {
    const raw = NETWORK_SOURCES[id];
    if (!raw) throw new Error(`Unknown network ${id}`);
    n = buildNetwork(raw);
    cache.set(id, n);
  }
  return n;
}

/** Build (and memoize by content) a network from a raw definition stored in an experiment. */
const rawCache = new Map<string, Network>();
export function networkFromRaw(raw: RawNetwork): Network {
  const key = raw.id ?? JSON.stringify(raw).length + ":" + raw.name;
  let n = rawCache.get(key);
  if (!n || JSON.stringify(n.raw) !== JSON.stringify(raw)) {
    n = buildNetwork(raw);
    rawCache.set(key, n);
  }
  return n;
}
