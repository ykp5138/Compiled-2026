import { useEffect, useMemo, useRef, useState } from "react";
import { getNetwork } from "../../../sim/network";
import type { Replay } from "../api";
import { fmt } from "../api";
import { drawFrame, fitTransform, FrameIndex } from "../render/mapRenderer";

const net = getNetwork();

export interface ControllerOption {
  id: string;
  label: string;
}

interface Props {
  side: "left" | "right";
  title: string;
  replay: Replay | null;
  loading: boolean;
  error: string | null;
  t: number;
  heat: boolean;
  controllerId: string;
  options: ControllerOption[];
  onController: (id: string) => void;
  /** Suite-level benchmark score for this controller on the scenario's suite, if known. */
  accent: string;
}

export function MapPanel({ side, title, replay, loading, error, t, heat, controllerId, options, onController, accent }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const index = useMemo(() => (replay ? new FrameIndex(replay) : null), [replay]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(200, Math.floor(r.height)) });
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
    drawFrame(ctx, net, fitTransform(net, w, h), w, h, replay, index, t, { heat, label: title });
  });

  const frame = replay ? replay.frames[Math.max(0, Math.min(replay.frames.length - 1, Math.floor(t / replay.frameEvery)))] : null;
  const live = frame ? { stopped: frame.m[0], released: frame.m[1], completed: frame.m[2], waiting: frame.m[3], p95: frame.m[4] } : null;
  const done = replay && t >= replay.horizon + replay.drain - 1e-6;

  return (
    <section className={`map-panel ${side}`}>
      <header className="map-head" style={{ borderColor: accent }}>
        <div className="map-title">
          <span className="side-tag" style={{ background: accent }}>{side === "left" ? "BASELINE" : "CANDIDATE"}</span>
          <select value={controllerId} onChange={(e) => onController(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {loading && <span className="muted small">simulating replay…</span>}
      </header>
      <div className="canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {error && <div className="canvas-msg error">{error}</div>}
      </div>
      <div className="metric-strip">
        <div className="metric-group">
          <div className="metric-caption">{done ? "Episode complete" : `Live · partial episode at t = ${Math.floor(t)} s`}</div>
          <div className="metrics">
            <Metric label="Stopped time / scheduled veh" value={live && replay ? fmt.s(live.stopped / replay.scheduled, 1) + " s" : "–"} hint="cumulative so far ÷ all vehicles scheduled in this episode" />
            <Metric label="Completed trips" value={live && replay ? `${live.completed} / ${replay.scheduled}` : "–"} />
            <Metric label="Waiting / queued now" value={live ? String(live.waiting) : "–"} hint="stopped in network + external entry queues" />
            <Metric label="P95 observed wait" value={live ? fmt.s(live.p95, 0) + " s" : "–"} hint="over released vehicles, including unfinished" />
          </div>
        </div>
        <div className="metric-group final">
          <div className="metric-caption">Episode final (same simulation run)</div>
          <div className="metrics">
            <Metric label="Score" value={replay ? fmt.s(replay.final.score) + " s/veh" : "–"} strong />
            <Metric label="Completion" value={replay ? (replay.final.completionFraction * 100).toFixed(1) + "%" : "–"} />
            <Metric label="Backlog at end" value={replay ? String(replay.final.inNetwork + replay.final.externalBacklog) : "–"} />
            <Metric label="P95 wait" value={replay ? fmt.s(replay.final.p95Wait, 0) + " s" : "–"} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="metric" title={hint}>
      <div className={`metric-value ${strong ? "strong" : ""}`}>{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
