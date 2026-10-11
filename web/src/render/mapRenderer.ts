// Canvas renderer for recorded simulation frames. It draws exactly what the simulator recorded:
// vehicle positions/lanes, signal states and external queues, interpolated between 1 s frames.
import type { Frame, Network, Replay } from "../../../sim";

export interface ViewTransform {
  scale: number;
  ox: number;
  oy: number;
}

export interface RenderOptions {
  heat: boolean;
  label: string;
}

const COLORS = {
  bg: "#0f1419",
  campus: "#15261c",
  campusEdge: "#244232",
  campusText: "#6f9c80",
  block: "#141a21",
  road: "#2a313b",
  roadEdge: "#3a4350",
  laneDash: "rgba(226,232,240,0.28)",
  center: "rgba(234,179,8,0.55)",
  car: "#d7dee8",
  carStroke: "#0b0f14",
  brake: "#f87171",
  green: "#22c55e",
  yellow: "#facc15",
  red: "#ef4444",
  label: "#94a3b8",
  labelStrong: "#e2e8f0",
  landmark: "#3b2f22",
  landmarkEdge: "#8a6b45",
};

export function fitTransform(net: Network, w: number, h: number): ViewTransform {
  const b = net.raw.map.bounds;
  const scale = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY));
  const ox = (w - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
  const oy = (h - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
  return { scale, ox, oy };
}

/** Drawn lane width (m): true 3.5 m, widened on small canvases so vehicles stay legible. Positions along links are exact. */
export function visualLaneWidth(net: Network, scale: number): number {
  return Math.min(net.raw.intersectionInset / 2, Math.max(net.raw.laneWidth, 5 / scale));
}

/** World position of a vehicle on (link, lane, pos). */
export function vehicleWorld(net: Network, li: number, lane: number, pos: number, w = net.raw.laneWidth): { x: number; y: number; ux: number; uy: number } {
  const l = net.links[li];
  const off = l.twoWay ? (lane + 0.5) * w : (lane - (l.lanes - 1) / 2) * w;
  const rx = -l.uy;
  const ry = l.ux;
  return { x: l.x0 + l.ux * pos + rx * off, y: l.y0 + l.uy * pos + ry * off, ux: l.ux, uy: l.uy };
}

/** Lazily built id -> vehicle index lookup per frame. */
export class FrameIndex {
  private maps: (Map<number, number> | undefined)[] = [];
  constructor(private readonly replay: Replay) {}
  get(k: number): Map<number, number> {
    let m = this.maps[k];
    if (!m) {
      m = new Map();
      const v = this.replay.frames[k].v;
      for (let i = 0; i < v.length; i += 4) m.set(v[i], i);
      this.maps[k] = m;
    }
    return m;
  }
}

interface Segment {
  a: { x: number; y: number };
  b: { x: number; y: number };
  lanesFwd: number;
  lanesBack: number;
  twoWay: boolean;
}

function roadSegments(net: Network): Segment[] {
  const nodes = new Map(net.raw.nodes.map((n) => [n.id, n]));
  const seen = new Map<string, Segment>();
  for (const l of net.links) {
    const key = [l.from, l.to].sort().join("|");
    const s = seen.get(key);
    if (s) {
      s.lanesBack = l.lanes;
      continue;
    }
    const a = nodes.get(l.from)!;
    const b = nodes.get(l.to)!;
    seen.set(key, { a, b, lanesFwd: l.lanes, lanesBack: 0, twoWay: l.twoWay });
  }
  return [...seen.values()];
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  net: Network,
  view: ViewTransform,
  cssW: number,
  cssH: number,
  replay: Replay | null,
  index: FrameIndex | null,
  t: number,
  opts: RenderOptions,
) {
  const { scale, ox, oy } = view;
  const X = (x: number) => ox + x * scale;
  const Y = (y: number) => oy + y * scale;
  const W = visualLaneWidth(net, scale);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Campus and landmarks (context only, not modeled roads).
  const c = net.raw.map.campus;
  ctx.fillStyle = COLORS.campus;
  ctx.strokeStyle = COLORS.campusEdge;
  ctx.lineWidth = 1;
  roundRect(ctx, X(c.x0), Y(c.y0), (c.x1 - c.x0) * scale, (c.y1 - c.y0) * scale, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.campusText;
  ctx.font = `600 ${Math.max(10, 12 * scale * 1.6)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(c.label, X(c.x0) + 10, Y(c.y0) + 8);
  for (const lm of net.raw.map.landmarks) {
    ctx.fillStyle = COLORS.landmark;
    ctx.strokeStyle = COLORS.landmarkEdge;
    roundRect(ctx, X(lm.x - lm.w / 2), Y(lm.y - lm.h / 2), lm.w * scale, lm.h * scale, 3);
    ctx.fill();
    ctx.stroke();
    // small bell tower
    ctx.fillStyle = COLORS.landmarkEdge;
    ctx.fillRect(X(lm.x) - 3 * scale, Y(lm.y - lm.h / 2) - 12 * scale, 6 * scale, 12 * scale);
    ctx.fillStyle = "#c9a878";
    ctx.font = `600 ${Math.max(10, 11 * scale * 1.6)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(lm.label, X(lm.x), Y(lm.y + lm.h / 2) + 4);
  }
  const dl = net.raw.map.downtownLabel;
  ctx.fillStyle = "#475569";
  ctx.font = `600 ${Math.max(10, 11 * scale * 1.6)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(dl.text, X(dl.x), Y(dl.y));

  // Roads.
  const segs = roadSegments(net);
  ctx.lineCap = "butt";
  for (const s of segs) {
    const width = (s.lanesFwd + s.lanesBack) * W + 2;
    ctx.strokeStyle = COLORS.roadEdge;
    ctx.lineWidth = (width + 1.2) * scale;
    line(ctx, X(s.a.x), Y(s.a.y), X(s.b.x), Y(s.b.y));
    ctx.strokeStyle = COLORS.road;
    ctx.lineWidth = width * scale;
    line(ctx, X(s.a.x), Y(s.a.y), X(s.b.x), Y(s.b.y));
  }

  // Queue heat overlay: per-link occupancy from the recorded frame.
  const k = replay ? Math.max(0, Math.min(replay.frames.length - 1, Math.floor(t / replay.frameEvery))) : 0;
  const frame: Frame | null = replay ? replay.frames[k] : null;
  if (opts.heat && frame) {
    const counts = new Array(net.links.length).fill(0);
    for (let i = 0; i < frame.v.length; i += 4) counts[frame.v[i + 1] >> 2]++;
    for (const l of net.links) {
      const occ = counts[l.idx] / Math.max(1, l.storagePerLane * l.lanes);
      if (occ < 0.05) continue;
      const off = l.twoWay ? (l.lanes * W) / 2 : 0;
      const rx = -l.uy * off;
      const ry = l.ux * off;
      ctx.strokeStyle = heatColor(occ);
      ctx.lineWidth = l.lanes * W * scale;
      line(ctx, X(l.x0 + rx), Y(l.y0 + ry), X(l.x1 + rx), Y(l.y1 + ry));
    }
  }

  // Lane markings.
  ctx.setLineDash([3 * scale, 4 * scale]);
  ctx.lineWidth = Math.max(0.6, 0.25 * scale);
  for (const l of net.links) {
    const rx = -l.uy;
    const ry = l.ux;
    for (let lane = 0; lane < l.lanes - 1; lane++) {
      const off = l.twoWay ? (lane + 1) * W : (lane + 1 - l.lanes / 2) * W;
      ctx.strokeStyle = COLORS.laneDash;
      line(ctx, X(l.x0 + rx * off), Y(l.y0 + ry * off), X(l.x1 + rx * off), Y(l.y1 + ry * off));
    }
  }
  ctx.setLineDash([]);
  for (const l of net.links) {
    if (!l.twoWay || l.ux + l.uy < 0) continue; // draw centre line once per two-way pair
    ctx.strokeStyle = COLORS.center;
    ctx.lineWidth = Math.max(0.8, 0.3 * scale);
    line(ctx, X(l.x0), Y(l.y0), X(l.x1), Y(l.y1));
  }

  // Intersection boxes.
  const inset = net.raw.intersectionInset;
  for (const inter of net.intersections) {
    ctx.fillStyle = COLORS.road;
    ctx.fillRect(X(inter.x - inset), Y(inter.y - inset), inset * 2 * scale, inset * 2 * scale);
  }

  // Street labels.
  ctx.fillStyle = COLORS.labelStrong;
  ctx.font = `600 ${Math.max(11, 12 * scale * 1.7)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const sl of net.raw.map.streetLabels) {
    ctx.save();
    ctx.translate(X(sl.x), Y(sl.y));
    ctx.rotate((sl.angle * Math.PI) / 180);
    ctx.fillText(sl.text, 0, 0);
    ctx.restore();
  }

  // Signals: stop bars coloured by the recorded signal state of each approach.
  for (const inter of net.intersections) {
    const phase = frame ? frame.s[inter.idx * 2] : 0;
    const state = frame ? frame.s[inter.idx * 2 + 1] : 2;
    for (const li of inter.approaches) {
      const l = net.links[li];
      const inPhase = inter.phases[phase].movements.some((mi) => net.movements[mi].from === li);
      const color = !frame ? COLORS.red : inPhase && state === 0 ? COLORS.green : inPhase && state === 1 ? COLORS.yellow : COLORS.red;
      const rx = -l.uy;
      const ry = l.ux;
      const o0 = l.twoWay ? 0.2 : (-l.lanes / 2) * W + 0.2;
      const o1 = l.twoWay ? l.lanes * W - 0.2 : (l.lanes / 2) * W - 0.2;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, 1.4 * scale);
      ctx.lineCap = "round";
      line(ctx, X(l.x1 + rx * o0), Y(l.y1 + ry * o0), X(l.x1 + rx * o1), Y(l.y1 + ry * o1));
      // signal head
      const hx = l.x1 + rx * (o1 + 2.6);
      const hy = l.y1 + ry * (o1 + 2.6);
      ctx.fillStyle = "#05070a";
      ctx.beginPath();
      ctx.arc(X(hx), Y(hy), Math.max(3, 2.2 * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(X(hx), Y(hy), Math.max(2, 1.5 * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.lineCap = "butt";
    }
  }

  // Vehicles (interpolated between recorded frames; identical neutral styling in every panel).
  if (replay && frame && index) {
    const k1 = Math.min(replay.frames.length - 1, k + 1);
    const alpha = Math.max(0, Math.min(1, t / replay.frameEvery - k));
    const next = index.get(k1);
    const nv = replay.frames[k1].v;
    const v = frame.v;
    const len = Math.min(6.4, Math.max(4.6, 4.6 * (W / 3.5)));
    const wid = W * 0.62;
    for (let i = 0; i < v.length; i += 4) {
      const id = v[i];
      const li = v[i + 1] >> 2;
      const lane = v[i + 1] & 3;
      const p0 = vehicleWorld(net, li, lane, v[i + 2] / 10, W);
      let x = p0.x;
      let y = p0.y;
      let ux = p0.ux;
      let uy = p0.uy;
      const j = next.get(id);
      if (j !== undefined && alpha > 0) {
        const p1 = vehicleWorld(net, nv[j + 1] >> 2, nv[j + 1] & 3, nv[j + 2] / 10, W);
        x = p0.x + (p1.x - p0.x) * alpha;
        y = p0.y + (p1.y - p0.y) * alpha;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && (nv[j + 1] >> 2) !== li) {
          ux = dx / d;
          uy = dy / d;
        }
      }
      // Vehicle front is at x,y; draw body behind it.
      ctx.save();
      ctx.translate(X(x - ux * (len / 2)), Y(y - uy * (len / 2)));
      ctx.rotate(Math.atan2(uy, ux));
      ctx.fillStyle = COLORS.car;
      ctx.strokeStyle = COLORS.carStroke;
      ctx.lineWidth = 0.6;
      roundRect(ctx, (-len / 2) * scale, (-wid / 2) * scale, len * scale, wid * scale, 0.6 * scale);
      ctx.fill();
      ctx.stroke();
      if (v[i + 3] === 1) {
        ctx.fillStyle = COLORS.brake;
        ctx.fillRect((-len / 2) * scale, (-wid / 2) * scale, 0.7 * scale, wid * scale);
      }
      ctx.restore();
    }

    // External entry queues (vehicles that could not yet enter the map).
    ctx.font = `700 ${Math.max(10, 11 * scale * 1.6)}px Inter, system-ui, sans-serif`;
    net.entries.forEach((li, ei) => {
      const n = frame.e[ei];
      if (!n) return;
      const l = net.links[li];
      const off = l.twoWay ? l.lanes * W * 0.5 : 0;
      const bx = l.x0 - l.ux * 6 + -l.uy * off;
      const by = l.y0 - l.uy * 6 + l.ux * off;
      const label = `+${n} waiting`;
      const tw = ctx.measureText(label).width + 10;
      const cx = Math.min(cssW - tw / 2 - 4, Math.max(tw / 2 + 4, X(bx)));
      const cy = Math.min(cssH - 30, Math.max(12, Y(by)));
      ctx.fillStyle = "rgba(239,68,68,0.9)";
      roundRect(ctx, cx - tw / 2, cy - 9, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy);
    });
  }

  // Panel caption, disclaimer and north arrow.
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#64748b";
  ctx.font = `500 11px Inter, system-ui, sans-serif`;
  ctx.fillText(net.raw.disclaimer, 10, cssH - 8);
  ctx.textAlign = "right";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 12px Inter, system-ui, sans-serif";
  ctx.fillText("N ↑", cssW - 12, cssH - 8);
}

function heatColor(occ: number): string {
  const o = Math.min(1, occ);
  if (o < 0.5) return `rgba(250,204,21,${0.12 + o * 0.35})`;
  return `rgba(239,68,68,${0.2 + (o - 0.5) * 0.6})`;
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
