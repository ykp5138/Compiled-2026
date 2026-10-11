// npm run preview:map -- [--network manhattan-east-village] [--theme a] [--out file.png] [--t 420]
// Renders the same canvas map the UI draws (heuristic replay of a dev scenario) to a PNG, headlessly.
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { arg } from "./args";

(globalThis as unknown as { Path2D: unknown }).Path2D = Path2D;
const { getNetwork, generateScenario, recordReplay, buildHeuristicPolicy } = await import("../../sim");
const { drawFrame, fitTransform, FrameIndex, PALETTES } = await import("../../web/src/render/mapRenderer");
const net = getNetwork(arg("network") ?? "manhattan-east-village");
const theme = arg("theme") ?? "a";
const out = arg("out") ?? `map-${net.raw.id ?? "network"}-${theme}.png`;
const t = Number(arg("t") ?? 420);
const sc = generateScenario(net, "dev", "bursty", 2003);
const rep = recordReplay(net, sc, buildHeuristicPolicy(net), "heuristic", "Heuristic");
const W = Number(arg("w") ?? 900);
const H = Number(arg("h") ?? 600);
const c = createCanvas(W, H);
const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
drawFrame(ctx, net, fitTransform(net, W, H), W, H, rep, new FrameIndex(rep), t, { heat: false, label: "preview", palette: PALETTES[theme] });
writeFileSync(out, c.toBuffer("image/png"));
console.log(`Wrote ${out}`);
