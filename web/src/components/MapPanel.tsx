import { useEffect, useMemo, useRef, useState } from "react";
import type { Network } from "../../../sim/network";
import type { Replay } from "../api";
import { fmt } from "../api";
import { liveAt } from "../derive";
import { useClock } from "../clock";
import { drawFrame, fitTransform, FrameIndex, type MapPalette } from "../render/mapRenderer";
import type { ControllerOption } from "../useGreenwave";

/** Canvas that draws recorded frames at time t. */
export function MapCanvas({ net, replay, t, heat, palette, label, error, loading }: { net: Network; replay: Replay | null; t: number; heat: boolean; palette: MapPalette; label: string; error?: string | null; loading?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const staticKey = useRef("");
  const index = useMemo(() => (replay ? new FrameIndex(replay) : null), [replay]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(160, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const { w, h } = size;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d")!;
    const view = fitTransform(net, w, h);
    // Static layer (blocks, roads, labels, inset) is drawn once per size/theme/network and cached.
    const key = `${net.raw.id ?? net.raw.name}|${w}x${h}@${dpr}|${palette.bg}|${palette.font}`;
    if (staticKey.current !== key || !staticRef.current) {
      const off = staticRef.current ?? document.createElement("canvas");
      off.width = Math.round(w * dpr);
      off.height = Math.round(h * dpr);
      const octx = off.getContext("2d")!;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrame(octx, net, view, w, h, null, null, 0, { heat: false, label, palette, layer: "static" });
      staticRef.current = off;
      staticKey.current = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticRef.current, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(ctx, net, view, w, h, replay, index, t, { heat, label, palette, layer: "dynamic" });
  });

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={`${label}: recorded simulation replay of ${net.raw.name}`} />
      {error && <div className="canvas-msg error">{error}</div>}
      {!error && loading && !replay && <div className="canvas-msg">Simulating replay…</div>}
    </div>
  );
}

interface Props {
  net: Network;
  side: "left" | "right";
  tag: string;
  replay: Replay | null;
  loading: boolean;
  error: string | null;
  heat: boolean;
  palette: MapPalette;
  controllerId: string;
  options: ControllerOption[];
  onController: (id: string) => void;
  caption?: string;
  /** Hide the live metric grid (e.g. when a layout shows a shared scoreboard instead). */
  bare?: boolean;
}

export function MapPanel({ net, side, tag, replay, loading, error, heat, palette, controllerId, options, onController, caption, bare }: Props) {
  const t = useClock();
  const live = liveAt(replay, t);
  return (
    <section className={`map-panel ${side}`} aria-label={tag}>
      <header className="map-head">
        <div className="map-title">
          <h2 className={`label ${side === "right" ? "champ" : ""}`}>{tag}</h2>
          <select aria-label={`${tag} controller`} value={controllerId} onChange={(e) => onController(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <span className="hint">{loading ? "simulating replay…" : caption ?? "synchronized · same synthetic traffic"}</span>
      </header>
      <MapCanvas net={net} replay={replay} t={t} heat={heat} palette={palette} label={tag} error={error} loading={loading} />
      {!bare && (
        <>
          <div className="metric-grid">
            <div>
              <div className="metric-l">Stopped time per scheduled vehicle</div>
              <div className="metric-v">{live ? `${fmt.s(live.stoppedPerVeh, 1)} s` : "–"}</div>
            </div>
            <div>
              <div className="metric-l">Trips completed</div>
              <div className="metric-v">{live ? `${live.completed} / ${live.scheduled}` : "–"}</div>
            </div>
            <div>
              <div className="metric-l">Waiting now</div>
              <div className="metric-v">{live ? live.waiting : "–"}</div>
            </div>
            <div>
              <div className="metric-l">P95 wait</div>
              <div className="metric-v">{live ? `${fmt.s(live.p95, 0)} s` : "–"}</div>
            </div>
          </div>
          <div className="metric-foot">
            <span>{live?.done ? "Episode complete" : `Live · partial episode at t = ${Math.floor(t)} s`}</span>
            {replay && (
              <span>
                Episode final: <b>{fmt.s(replay.final.score)} s/veh</b> · completion <b>{(replay.final.completionFraction * 100).toFixed(1)}%</b> · unfinished <b>{replay.final.inNetwork + replay.final.externalBacklog}</b>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
