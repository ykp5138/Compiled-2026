// npm run build:manhattan — builds sim/networks/manhattan-east-village.json from Google Maps Routes API lookups.
// For every avenue × street intersection it asks the Routes API for the snapped start location of a route
// beginning at "<street> & <avenue>, New York, NY", projects lat/lng to metres, rotates to "Manhattan north"
// (avenues vertical), and snaps each avenue/street to the median of its intersections. Lanes, one-way
// directions, turns and phases are simulation assumptions (documented in the file's notes).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config";

const KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";
if (!KEY) throw new Error("GOOGLE_MAPS_API_KEY missing in .env");

type Dir = "N" | "S" | "E" | "W";
interface Ave { code: string; name: string; query: string; dirs: Dir[]; lanes: number; speed: number; rate: number }
interface St { code: string; name: string; query: string; dirs: Dir[]; lanes: number; speed: number; rate: number }

// West → east. NB = toward 14th St (north), SB = toward 9th St.
const AVES: Ave[] = [
  { code: "A2", name: "2nd Ave", query: "2nd Ave", dirs: ["S"], lanes: 3, speed: 11.2, rate: 1400 },
  { code: "A1", name: "1st Ave", query: "1st Ave", dirs: ["N"], lanes: 3, speed: 11.2, rate: 1400 },
  { code: "AA", name: "Avenue A", query: "Avenue A", dirs: ["N", "S"], lanes: 1, speed: 8.9, rate: 320 },
  { code: "AB", name: "Avenue B", query: "Avenue B", dirs: ["N", "S"], lanes: 1, speed: 8.9, rate: 260 },
];
// North → south. E 14th is two-way; numbered side streets alternate (odd westbound, even eastbound).
const STS: St[] = [
  { code: "S14", name: "E 14th St", query: "E 14th St", dirs: ["E", "W"], lanes: 2, speed: 11.2, rate: 700 },
  { code: "S13", name: "E 13th St", query: "E 13th St", dirs: ["W"], lanes: 1, speed: 8.9, rate: 220 },
  { code: "S12", name: "E 12th St", query: "E 12th St", dirs: ["E"], lanes: 1, speed: 8.9, rate: 220 },
  { code: "S11", name: "E 11th St", query: "E 11th St", dirs: ["W"], lanes: 1, speed: 8.9, rate: 220 },
  { code: "S10", name: "E 10th St", query: "E 10th St", dirs: ["E"], lanes: 1, speed: 8.9, rate: 220 },
  { code: "S9", name: "E 9th St", query: "E 9th St", dirs: ["W"], lanes: 1, speed: 8.9, rate: 220 },
];

const cacheFile = path.join(ROOT, "data", "cache", "manhattan-intersections.json");
const cache: Record<string, { lat: number; lng: number }> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};

async function lookup(street: string, ave: string): Promise<{ lat: number; lng: number }> {
  const key = `${street} & ${ave}`;
  if (cache[key]) return cache[key];
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "routes.legs.startLocation" },
    body: JSON.stringify({ origin: { address: `${street} & ${ave}, New York, NY` }, destination: { address: "Union Square, New York, NY" }, travelMode: "DRIVE" }),
  });
  const body = (await res.json()) as { routes?: { legs: { startLocation: { latLng: { latitude: number; longitude: number } } }[] }[]; error?: { message: string } };
  if (!res.ok || !body.routes?.[0]) throw new Error(`Routes API failed for ${key}: ${body.error?.message ?? res.status}`);
  const ll = body.routes[0].legs[0].startLocation.latLng;
  cache[key] = { lat: ll.latitude, lng: ll.longitude };
  return cache[key];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const pts: Record<string, { lat: number; lng: number }> = {};
for (const st of STS) for (const av of AVES) pts[`${st.code}_${av.code}`] = await lookup(st.query, av.query);
mkdirSync(path.dirname(cacheFile), { recursive: true });
writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
console.log(`Looked up ${Object.keys(pts).length} intersections via Google Maps Routes API`);

// Local metres (x east, y north) around the centroid.
const lat0 = median(Object.values(pts).map((p) => p.lat));
const lng0 = median(Object.values(pts).map((p) => p.lng));
const toXY = (p: { lat: number; lng: number }) => ({ x: (p.lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180), y: (p.lat - lat0) * 110540 });
// Avenue bearing from the 14th → 9th St points of each avenue (robust median of per-avenue angles).
const angles = AVES.map((av) => {
  const a = toXY(pts[`S14_${av.code}`]);
  const b = toXY(pts[`S9_${av.code}`]);
  return Math.atan2(a.x - b.x, a.y - b.y); // clockwise from north
});
const theta = median(angles);
console.log(`Avenue bearing ≈ ${((theta * 180) / Math.PI).toFixed(1)}° east of true north (rotated to vertical)`);
const rot = (p: { lat: number; lng: number }) => {
  const { x, y } = toXY(p);
  const along = x * Math.sin(theta) + y * Math.cos(theta); // toward 14th St
  const across = x * Math.cos(theta) - y * Math.sin(theta); // toward Avenue B
  return { X: across, Y: -along };
};
const R = Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, rot(p)]));
const aveX: Record<string, number> = {};
for (const av of AVES) aveX[av.code] = median(STS.map((st) => R[`${st.code}_${av.code}`].X));
const stY: Record<string, number> = {};
for (const st of STS) stY[st.code] = median(AVES.map((av) => R[`${st.code}_${av.code}`].Y));
const x0 = aveX[AVES[0].code];
const y0 = stY[STS[0].code];
for (const k of Object.keys(aveX)) aveX[k] = Math.round(aveX[k] - x0);
for (const k of Object.keys(stY)) stY[k] = Math.round(stY[k] - y0);
console.log("Avenue x (m):", JSON.stringify(aveX), " street y (m):", JSON.stringify(stY));

// Sanity: monotone ordering.
for (let i = 1; i < AVES.length; i++) if (aveX[AVES[i].code] <= aveX[AVES[i - 1].code]) throw new Error("avenue order not monotone");
for (let i = 1; i < STS.length; i++) if (stY[STS[i].code] <= stY[STS[i - 1].code]) throw new Error("street order not monotone");

// Context-only avenues further east (not modeled): Avenue C and Avenue D, located with the same Google lookups.
const CONTEXT_AVES = [
  { name: "Avenue C", query: "Avenue C" },
  { name: "Avenue D", query: "Avenue D" },
];
const contextX: Record<string, number> = {};
for (const ca of CONTEXT_AVES) {
  const xs: number[] = [];
  for (const st of [STS[1], STS[3], STS[5]]) xs.push(rot(await lookup(st.query, ca.query)).X - x0);
  contextX[ca.name] = Math.round(median(xs));
}
writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
console.log("Context avenues x (m):", JSON.stringify(contextX));

// Manhattan Island outline: OpenStreetMap (Nominatim, relation 3954665), © OpenStreetMap contributors (ODbL).
// Google Maps Platform has no API that returns coastline geometry.
const islandFile = path.join(ROOT, "data", "cache", "nominatim-manhattan.json");
if (!existsSync(islandFile)) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?q=Manhattan%20Island&format=json&polygon_geojson=1&polygon_threshold=0.0002&limit=1", { headers: { "User-Agent": "greenwave-hackathon/0.1" } });
  writeFileSync(islandFile, await r.text());
}
const island = (JSON.parse(readFileSync(islandFile, "utf8")) as { geojson: { type: string; coordinates: number[][][] | number[][][][] } }[])[0].geojson;
const polys = (island.type === "Polygon" ? [island.coordinates] : island.coordinates) as number[][][][];
const land = polys
  .map((poly) => poly[0].map(([lng, lat]) => {
    const q = rot({ lat, lng });
    return [Math.round(q.X - x0), Math.round(q.Y - y0)];
  }))
  .filter((ring) => ring.length >= 4);
console.log(`Island outline: ${land.length} ring(s), ${land.reduce((a, r) => a + r.length, 0)} points`);

const EXT_V = 90;
const EXT_H = 110;
const nodes: { id: string; kind: "signal" | "boundary"; x: number; y: number; name?: string }[] = [];
for (const st of STS) for (const av of AVES) nodes.push({ id: `${st.code}_${av.code}`, kind: "signal", x: aveX[av.code], y: stY[st.code], name: `${st.name} & ${av.name}` });
const yN = stY[STS[0].code] - EXT_V;
const yS = stY[STS[STS.length - 1].code] + EXT_V;
const xW = aveX[AVES[0].code] - EXT_H;
const xE = aveX[AVES[AVES.length - 1].code] + EXT_H;
for (const av of AVES) {
  nodes.push({ id: `BN_${av.code}`, kind: "boundary", x: aveX[av.code], y: yN });
  nodes.push({ id: `BS_${av.code}`, kind: "boundary", x: aveX[av.code], y: yS });
}
for (const st of STS) {
  nodes.push({ id: `BW_${st.code}`, kind: "boundary", x: xW, y: stY[st.code] });
  nodes.push({ id: `BE_${st.code}`, kind: "boundary", x: xE, y: stY[st.code] });
}
const nodeXY = new Map(nodes.map((n) => [n.id, n]));

interface L { id: string; from: string; to: string; street: string; dir: string; lanes: number; speed: number }
const links: L[] = [];
const addChain = (ids: string[], street: string, dir: string, lanes: number, speed: number, tag: string) => {
  for (let i = 0; i + 1 < ids.length; i++) links.push({ id: `${tag}_${i}`, from: ids[i], to: ids[i + 1], street, dir, lanes, speed });
};
for (const av of AVES) {
  const southward = [`BN_${av.code}`, ...STS.map((s) => `${s.code}_${av.code}`), `BS_${av.code}`];
  if (av.dirs.includes("S")) addChain(southward, av.name, "SB", av.lanes, av.speed, `${av.code}_sb`);
  if (av.dirs.includes("N")) addChain([...southward].reverse(), av.name, "NB", av.lanes, av.speed, `${av.code}_nb`);
}
for (const st of STS) {
  const eastward = [`BW_${st.code}`, ...AVES.map((a) => `${st.code}_${a.code}`), `BE_${st.code}`];
  if (st.dirs.includes("E")) addChain(eastward, st.name, "EB", st.lanes, st.speed, `${st.code}_eb`);
  if (st.dirs.includes("W")) addChain([...eastward].reverse(), st.name, "WB", st.lanes, st.speed, `${st.code}_wb`);
}
const unit = (l: L) => {
  const a = nodeXY.get(l.from)!;
  const b = nodeXY.get(l.to)!;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};

// Movements and two phases per intersection (avenue / street). Left turns are omitted from approaches
// that have an opposing approach (two-way streets), so no phase contains a permissive left.
const intersections = nodes
  .filter((n) => n.kind === "signal")
  .map((n) => {
    const ins = links.filter((l) => l.to === n.id);
    const outs = links.filter((l) => l.from === n.id);
    const movements: [string, string, string][] = [];
    const phases = [
      { name: "", movements: [] as string[] },
      { name: "", movements: [] as string[] },
    ];
    for (const a of ins) {
      const ua = unit(a);
      const vertical = Math.abs(ua.y) > Math.abs(ua.x);
      const opposed = ins.some((b) => b !== a && unit(b).x * ua.x + unit(b).y * ua.y < -0.5);
      for (const b of outs) {
        if (b.to === a.from) continue; // no U-turns
        const ub = unit(b);
        const dot = ua.x * ub.x + ua.y * ub.y;
        const cross = ua.x * ub.y - ua.y * ub.x;
        const turn = dot > 0.5 ? "T" : cross > 0 ? "R" : "L";
        if (turn === "L" && opposed) continue;
        movements.push([a.id, b.id, turn]);
        phases[vertical ? 0 : 1].movements.push(`${a.id}>${b.id}`);
      }
    }
    const names = (vertical: boolean) => [...new Set(ins.filter((l) => (Math.abs(unit(l).y) > Math.abs(unit(l).x)) === vertical).map((l) => `${l.street} ${l.dir}`))].join(" / ");
    phases[0].name = names(true);
    phases[1].name = names(false);
    return { id: n.id, movements, phases };
  });

// Demand: every entry link; destination shares over reachable exits (55% straight through when possible).
const entries = links.filter((l) => nodeXY.get(l.from)!.kind === "boundary");
const exits = links.filter((l) => nodeXY.get(l.to)!.kind === "boundary");
const next = new Map<string, string[]>();
for (const i of intersections) for (const [a, b] of i.movements) next.set(a, [...(next.get(a) ?? []), b]);
const reach = (start: string) => {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) for (const n of next.get(q.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), q.push(n));
  return exits.filter((e) => seen.has(e.id)).map((e) => e.id);
};
const rateOf = (l: L) => (AVES.find((a) => a.name === l.street) ?? STS.find((s) => s.name === l.street))!.rate;
const baseVehPerHour: Record<string, number> = {};
const destinationShares: Record<string, Record<string, number>> = {};
for (const e of entries) {
  baseVehPerHour[e.id] = rateOf(e);
  const r = reach(e.id).filter((x) => links.find((l) => l.id === x)!.street !== e.street || true);
  const straight = r.find((x) => {
    const l = links.find((k) => k.id === x)!;
    return l.street === e.street && l.dir === e.dir;
  });
  const others = r.filter((x) => x !== straight);
  const shares: Record<string, number> = {};
  if (straight) shares[straight] = others.length ? 0.55 : 1;
  for (const o of others) shares[o] = +((straight ? 0.45 : 1) / others.length).toFixed(4);
  const sum = Object.values(shares).reduce((a, b) => a + b, 0);
  const last = Object.keys(shares)[Object.keys(shares).length - 1];
  shares[last] = +(shares[last] + 1 - sum).toFixed(4);
  destinationShares[e.id] = shares;
}
const arterialOrigins = entries.filter((e) => e.street === "1st Ave" || e.street === "2nd Ave").map((e) => e.id);
const crossArterialOrigins = entries.filter((e) => e.street === "E 14th St").map((e) => e.id);
const sideStreetOrigins = entries.filter((e) => !arterialOrigins.includes(e.id) && !crossArterialOrigins.includes(e.id)).map((e) => e.id);

// East River shoreline beside the study area (max land x within the modeled street range).
const shoreX = Math.max(...land.flat().length ? land.flatMap((r) => r.filter(([, y]) => y > yN - 50 && y < yS + 50).map(([x]) => x)) : [xE]);
const minX = xW - 20;
// Detail view stays on the modeled streets (+ Avenue C as context) so vehicles stay legible;
// the whole island and both rivers are shown in the map inset.
const maxX = Math.round(Math.max(xE + 20, contextX["Avenue C"] + 60));
console.log(`East River shore at x ≈ ${shoreX} m; detail view extends to ${maxX} m`);
const minY = yN - 70;
const maxY = yS + 20;
const raw = {
  id: "manhattan-east-village",
  name: "Downtown Manhattan · East Village grid",
  disclaimer: "Simplified Manhattan (East Village) network · geometry from Google Maps · synthetic traffic",
  description: [
    `Simplified downtown Manhattan network (East Village), synthetic traffic, ${intersections.length} signals. Drawn with avenues vertical ("Manhattan north"); the real grid is rotated about ${Math.round((theta * 180) / Math.PI)}° east of true north.`,
    "Avenues west to east: 2nd Ave (one-way SOUTHBOUND, 3 lanes), 1st Ave (one-way NORTHBOUND, 3 lanes), Avenue A and Avenue B (two-way, 1 lane each way). Main arterials: 1st and 2nd Ave.",
    "Streets north to south: E 14th St (two-way, 2 lanes each way, main crosstown), then one-way side streets E 13th (WB), E 12th (EB), E 11th (WB), E 10th (EB), E 9th (WB). Side streets and Avenues A/B are the minor approaches to protect from starvation.",
    "Intersection IDs are <street>_<avenue>, e.g. S14_A1 = E 14th St & 1st Ave. Phase 0 = avenue movements, phase 1 = street movements.",
  ],
  notes: [
    "Intersection coordinates from Google Maps Routes API lookups (one per avenue × street), projected to metres, rotated so avenues are vertical, and snapped to the median position of each avenue and street.",
    "Lane counts, one-way directions and turn permissions are approximate simulation assumptions; left turns from two-way approaches are omitted (no permissive lefts).",
    "Every intersection is modeled as signalized with two phases (avenue / street). Pedestrians, parking, buses and bike lanes are not modeled.",
  ],
  laneWidth: 3.5,
  intersectionInset: 12,
  nodes,
  links: links.map(({ id, from, to, street, dir, lanes, speed }) => ({ id, from, to, street, dir, lanes, speed })),
  intersections,
  demand: { baseVehPerHour, sideStreetOrigins, arterialOrigins, crossArterialOrigins, destinationShares },
  map: {
    bounds: { minX, minY, maxX, maxY },
    areas: [
      { label: "Stuyvesant Town", x0: aveX.A1 + 20, y0: minY + 6, x1: aveX.AB + 60, y1: yN + 70 - 20, kind: "park" },
      { label: "Tompkins Sq. Park", x0: aveX.AA + 18, y0: stY.S10 + 18, x1: aveX.AB - 18, y1: maxY, kind: "park" },
    ],
    landmarks: [],
    land,
    water: { label: "East River", x: Math.round((shoreX + maxX) / 2), y: Math.round((stY.S12 + stY.S11) / 2) },
    contextStreets: CONTEXT_AVES.map((c) => ({ label: c.name, x0: contextX[c.name], y0: minY, x1: contextX[c.name], y1: maxY })),
    attribution: "Streets: Google Maps Routes API · coastline © OpenStreetMap contributors",
    downtownLabel: { text: "East Village · Manhattan", x: (aveX.A2 + aveX.A1) / 2, y: (stY.S11 + stY.S10) / 2 },
    streetLabels: [
      // Labels are rotated -90°, so "→" renders pointing north and "←" south.
      ...AVES.map((a) => ({ text: `${a.name}${a.dirs.length === 1 ? (a.dirs[0] === "N" ? "  →" : "  ←") : ""}`, x: aveX[a.code] - 18, y: yS - 40, angle: -90 })),
      ...STS.map((s) => ({ text: `${s.name}${s.dirs.length === 1 ? (s.dirs[0] === "E" ? " →" : " ←") : ""}`, x: xW + 42, y: stY[s.code] - 14, angle: 0 })),
    ],
  },
};
const out = path.join(ROOT, "sim", "networks", "manhattan-east-village.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(raw, null, 1));
console.log(`Wrote ${path.relative(ROOT, out)}: ${intersections.length} signals, ${links.length} links, ${entries.length} entries`);
