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
  palette: MapPalette;
}

export interface MapPalette {
  bg: string;
  water: string;
  waterText: string;
  block: string;
  campus: string;
  campusEdge: string;
  campusText: string;
  road: string;
  roadEdge: string;
  laneDash: string;
  center: string;
  car: string;
  carStroke: string;
  brake: string;
  green: string;
  yellow: string;
  red: string;
  head: string;
  label: string;
  halo: string;
  landmark: string;
  landmarkEdge: string;
  landmarkText: string;
  faint: string;
  font: string;
}

/** One palette per layout (Claude Design directions A–D). Cars are the same neutral style in both panels. */
export const PALETTES: Record<string, MapPalette> = {
  a: {
    water: "#1b2a36", waterText: "#7d9bb3",
    bg: "#1a2029", block: "#1f2630", campus: "#1c3a31", campusEdge: "#27493d", campusText: "#7fc29b",
    road: "#3a4453", roadEdge: "#12171e", laneDash: "rgba(226,232,240,0.28)", center: "rgba(217,171,87,0.55)",
    car: "#d5d9de", carStroke: "#0b0f14", brake: "#f0524b", green: "#2fd27e", yellow: "#f7c843", red: "#f0524b", head: "#0a0d12",
    label: "#b4becb", halo: "#12171e", landmark: "#27493d", landmarkEdge: "#5f8f76", landmarkText: "#a7d6b9", faint: "#6b7480", font: "Geist, system-ui, sans-serif",
  },
  b: {
    water: "#cfe0e3", waterText: "#3f6f80",
    bg: "#ece6d8", block: "#e2dbca", campus: "#cfe0c6", campusEdge: "#a9c39c", campusText: "#23573a",
    road: "#fbf8f1", roadEdge: "#c9c0ac", laneDash: "rgba(88,96,88,0.35)", center: "rgba(217,152,43,0.7)",
    car: "#4d544e", carStroke: "#fbf8f1", brake: "#c7352c", green: "#1e7a46", yellow: "#d9982b", red: "#c7352c", head: "#17201b",
    label: "#17201b", halo: "#f6f1e7", landmark: "#b2cdae", landmarkEdge: "#5f8a63", landmarkText: "#23573a", faint: "#8a8672", font: "'Hanken Grotesk', system-ui, sans-serif",
  },
  c: {
    water: "#0e1820", waterText: "#6f93ad",
    bg: "#101113", block: "#17191c", campus: "#18291f", campusEdge: "#24402f", campusText: "#97cdaa",
    road: "#2b2e33", roadEdge: "#0b0c0e", laneDash: "rgba(213,217,222,0.25)", center: "rgba(242,180,65,0.55)",
    car: "#d5d9de", carStroke: "#0b0c0e", brake: "#f0524b", green: "#2fd27e", yellow: "#f2b441", red: "#f0524b", head: "#0b0c0e",
    label: "#d5d9de", halo: "#0b0c0e", landmark: "#24402f", landmarkEdge: "#5f8f76", landmarkText: "#97cdaa", faint: "#7c838c", font: "Barlow, system-ui, sans-serif",
  },
  d: {
    water: "#d6e6ef", waterText: "#2f6584",
    bg: "#e7e9ec", block: "#dcdfe3", campus: "#cfe3d3", campusEdge: "#a8c9b0", campusText: "#1f5a38",
    road: "#ffffff", roadEdge: "#c3c8cf", laneDash: "rgba(90,98,109,0.35)", center: "rgba(217,119,6,0.6)",
    car: "#5a626d", carStroke: "#ffffff", brake: "#dc2626", green: "#15803d", yellow: "#d97706", red: "#dc2626", head: "#1b1f24",
    label: "#1b1f24", halo: "#edeff2", landmark: "#afcfb8", landmarkEdge: "#5f8a6a", landmarkText: "#1f5a38", faint: "#7b838e", font: "'Schibsted Grotesk', system-ui, sans-serif",
  },
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
  const P = opts.palette;
  const F = (weight: number, px: number) => `${weight} ${px}px ${P.font}`;

  const land = net.raw.map.land;
  const landPath = (tx: (x: number) => number, ty: (y: number) => number) => {
    const p = new Path2D();
    for (const ring of land ?? []) {
      ring.forEach(([x, y], i) => (i === 0 ? p.moveTo(tx(x), ty(y)) : p.lineTo(tx(x), ty(y))));
      p.closePath();
    }
    return p;
  };
  if (land) {
    ctx.fillStyle = P.water;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.save();
    const lp = landPath(X, Y);
    ctx.fillStyle = P.bg;
    ctx.fill(lp);
    ctx.clip(lp);
  } else {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  // City blocks between modeled streets (context only), derived from signal positions.
  {
    const b = net.raw.map.bounds;
    const uniq = (vals: number[]) => [...new Set(vals.map((v) => Math.round(v)))].sort((p, q) => p - q);
    const xs = [b.minX, ...uniq([...net.intersections.map((i) => i.x), ...(net.raw.map.contextStreets ?? []).map((c) => c.x0)]), b.maxX];
    const ys = [b.minY, ...uniq(net.intersections.map((i) => i.y)), b.maxY];
    const m = net.raw.intersectionInset + 2;
    ctx.fillStyle = P.block;
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < ys.length - 1; j++) {
        const x0 = xs[i] + (i === 0 ? 0 : m);
        const x1 = xs[i + 1] - (i === xs.length - 2 ? 0 : m);
        const y0 = ys[j] + (j === 0 ? 0 : m);
        const y1 = ys[j + 1] - (j === ys.length - 2 ? 0 : m);
        if (x1 - x0 > 4 && y1 - y0 > 4) {
          roundRect(ctx, X(x0), Y(y0), (x1 - x0) * scale, (y1 - y0) * scale, 4);
          ctx.fill();
        }
      }
    }
  }

  // Context areas (campus, parks) and landmarks; not modeled roads.
  const areas = [...(net.raw.map.campus ? [net.raw.map.campus] : []), ...(net.raw.map.areas ?? [])];
  for (const c of areas) {
    ctx.fillStyle = P.campus;
    ctx.strokeStyle = P.campusEdge;
    ctx.lineWidth = 1;
    roundRect(ctx, X(c.x0), Y(c.y0), (c.x1 - c.x0) * scale, (c.y1 - c.y0) * scale, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = P.campusText;
    ctx.font = F(600, Math.max(10, 12 * scale * 1.6));
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(c.label, X(c.x0) + 10, Y(c.y0) + 8);
  }
  for (const lm of net.raw.map.landmarks ?? []) {
    ctx.fillStyle = P.landmark;
    ctx.strokeStyle = P.landmarkEdge;
    roundRect(ctx, X(lm.x - lm.w / 2), Y(lm.y - lm.h / 2), lm.w * scale, lm.h * scale, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = P.landmarkEdge;
    ctx.fillRect(X(lm.x) - 3 * scale, Y(lm.y - lm.h / 2) - 12 * scale, 6 * scale, 12 * scale);
    ctx.fillStyle = P.landmarkText;
    ctx.font = F(600, Math.max(10, 11 * scale * 1.6));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(lm.label, X(lm.x), Y(lm.y + lm.h / 2) + 4);
  }
  const dl = net.raw.map.downtownLabel;
  if (dl) {
    ctx.fillStyle = P.faint;
    ctx.font = F(600, Math.max(10, 11 * scale * 1.6));
    ctx.textAlign = "center";
    ctx.fillText(dl.text, X(dl.x), Y(dl.y));
  }
  // Unmodeled context streets (faint, no signals or traffic).
  for (const c of net.raw.map.contextStreets ?? []) {
    ctx.strokeStyle = P.road;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2 * W * scale;
    line(ctx, X(c.x0), Y(c.y0), X(c.x1), Y(c.y1));
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(X(c.x0) - 2 * W * scale, Y((c.y0 + c.y1) / 2));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = P.faint;
    ctx.font = F(500, 11);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${c.label} · not modeled`, 0, 0);
    ctx.restore();
  }
  if (land) ctx.restore();
  const wl = net.raw.map.water;
  if (wl && X(wl.x) < cssW - 20) {
    ctx.fillStyle = P.waterText;
    ctx.font = F(600, 13);
    ctx.textAlign = "center";
    ctx.fillText(wl.label, X(wl.x), Y(wl.y));
  }

  // Roads.
  const segs = roadSegments(net);
  ctx.lineCap = "butt";
  for (const s of segs) {
    const width = (s.lanesFwd + s.lanesBack) * W + 2;
    ctx.strokeStyle = P.roadEdge;
    ctx.lineWidth = (width + 1.2) * scale;
    line(ctx, X(s.a.x), Y(s.a.y), X(s.b.x), Y(s.b.y));
    ctx.strokeStyle = P.road;
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
      ctx.strokeStyle = P.laneDash;
      line(ctx, X(l.x0 + rx * off), Y(l.y0 + ry * off), X(l.x1 + rx * off), Y(l.y1 + ry * off));
    }
  }
  ctx.setLineDash([]);
  for (const l of net.links) {
    if (!l.twoWay || l.ux + l.uy < 0) continue; // draw centre line once per two-way pair
    ctx.strokeStyle = P.center;
    ctx.lineWidth = Math.max(0.8, 0.3 * scale);
    line(ctx, X(l.x0), Y(l.y0), X(l.x1), Y(l.y1));
  }

  // Intersection boxes.
  const inset = net.raw.intersectionInset;
  for (const inter of net.intersections) {
    ctx.fillStyle = P.road;
    ctx.fillRect(X(inter.x - inset), Y(inter.y - inset), inset * 2 * scale, inset * 2 * scale);
  }

  // Street labels.
  ctx.fillStyle = P.label;
  ctx.font = F(600, Math.max(11, 12 * scale * 1.7));
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
      const color = !frame ? P.red : inPhase && state === 0 ? P.green : inPhase && state === 1 ? P.yellow : P.red;
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
      ctx.fillStyle = P.head;
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
      ctx.fillStyle = P.car;
      ctx.strokeStyle = P.carStroke;
      ctx.lineWidth = 0.6;
      roundRect(ctx, (-len / 2) * scale, (-wid / 2) * scale, len * scale, wid * scale, 0.6 * scale);
      ctx.fill();
      ctx.stroke();
      if (v[i + 3] === 1) {
        ctx.fillStyle = P.brake;
        ctx.fillRect((-len / 2) * scale, (-wid / 2) * scale, 0.7 * scale, wid * scale);
      }
      ctx.restore();
    }

    // External entry queues (vehicles that could not yet enter the map).
    ctx.font = F(700, Math.max(10, 11 * scale * 1.6));
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

  if (land) drawIslandInset(ctx, net, cssW, cssH, P, F, landPath);
  if (net.raw.map.attribution) {
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = P.faint;
    ctx.font = F(500, 10);
    ctx.fillText(net.raw.map.attribution, cssW - 40, cssH - 8);
  }

  // Panel caption, disclaimer and north arrow.
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = P.faint;
  ctx.font = F(500, 11);
  ctx.fillText(net.raw.disclaimer, 10, cssH - 8);
  ctx.textAlign = "right";
  ctx.fillStyle = P.label;
  ctx.font = F(700, 12);
  ctx.fillText(land ? "Grid N ↑" : "N ↑", cssW - 12, cssH - (net.raw.map.attribution ? 22 : 8));
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

/** Whole-island locator inset (same rotated frame as the detail map), with the modeled area highlighted. */
function drawIslandInset(
  ctx: CanvasRenderingContext2D,
  net: Network,
  cssW: number,
  cssH: number,
  P: MapPalette,
  F: (w: number, px: number) => string,
  landPath: (tx: (x: number) => number, ty: (y: number) => number) => Path2D,
) {
  const rings = net.raw.map.land ?? [];
  const pts = rings.flat();
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const padM = 600;
  const h = Math.min(cssH * 0.62, 280);
  const k = (h - 28) / (maxY - minY + 2 * padM);
  const w = (maxX - minX + 2 * padM) * k + 16;
  const x0 = cssW - w - 10;
  const y0 = 10;
  const tx = (x: number) => x0 + 8 + (x - minX + padM) * k;
  const ty = (y: number) => y0 + 20 + (y - minY + padM) * k;
  ctx.save();
  roundRect(ctx, x0, y0, w, h, 6);
  ctx.fillStyle = P.water;
  ctx.fill();
  ctx.strokeStyle = P.faint;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  ctx.fillStyle = P.block;
  ctx.fill(landPath(tx, ty));
  ctx.strokeStyle = P.landmarkEdge;
  ctx.stroke(landPath(tx, ty));
  // Modeled area.
  const xs = net.intersections.map((i) => i.x);
  const ys = net.intersections.map((i) => i.y);
  const ax = tx(Math.min(...xs)) - 2;
  const ay = ty(Math.min(...ys)) - 2;
  const aw = (Math.max(...xs) - Math.min(...xs)) * k + 4;
  const ah = (Math.max(...ys) - Math.min(...ys)) * k + 4;
  ctx.fillStyle = P.red;
  ctx.fillRect(ax, ay, Math.max(4, aw), Math.max(4, ah));
  ctx.strokeStyle = P.red;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(ax + aw / 2, ay + ah / 2, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = P.label;
  ctx.font = F(700, 11);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("MANHATTAN", x0 + w / 2, y0 + 5);
  ctx.fillStyle = P.waterText;
  ctx.font = F(600, 9);
  ctx.save();
  ctx.translate(x0 + 9, y0 + h * 0.5);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Hudson River", 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(x0 + w - 9, y0 + h * 0.62);
  ctx.rotate(Math.PI / 2);
  ctx.fillText("East River", 0, 0);
  ctx.restore();
  ctx.fillStyle = P.red;
  ctx.font = F(700, 9);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("modeled", ax - 12, ay + ah / 2);
  ctx.restore();
}
