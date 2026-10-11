import { useEffect, useMemo, useRef, useState } from "react";
import { getNetwork } from "../../../sim/network";
import type { Replay } from "../api";
import { fmt } from "../api";
import { liveAt } from "../derive";
import { drawFrame, fitTransform, FrameIndex, type MapPalette } from "../render/mapRenderer";
import type { ControllerOption } from "../useGreenwave";

const net = getNetwork();

/** Canvas that draws recorded frames at time t. */
export function MapCanvas({ replay, t, heat, palette, label, error, loading }: { replay: Replay | null; t: number; heat: boolean; palette: MapPalette; label: string; error?: string | null; loading?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(ctx, net, fitTransform(net, w, h), w, h, replay, index, t, { heat, label, palette });
  });

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={`${label}: recorded simulation replay of the simplified State College network`} />
      {error && <div className="canvas-msg error">{error}</div>}
      {!error && loading && !replay && <div className="canvas-msg">Simulating replay…</div>}
    </div>
  );
}

interface Props {
  side: "left" | "right";
  tag: string;
  replay: Replay | null;
  loading: boolean;
  error: string | null;
  t: number;
  heat: boolean;
  palette: MapPalette;
  controllerId: string;
  options: ControllerOption[];
  onController: (id: string) => void;
  caption?: string;
  /** Hide the live metric grid (e.g. when a layout shows a shared scoreboard instead). */
  bare?: boolean;
}

export function MapPanel({ side, tag, replay, loading, error, t, heat, palette, controllerId, options, onController, caption, bare }: Props) {
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
      <MapCanvas replay={replay} t={t} heat={heat} palette={palette} label={tag} error={error} loading={loading} />
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
