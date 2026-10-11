import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, subscribe, type PublicState, type Replay } from "./api";
import { MapPanel, type ControllerOption } from "./components/MapPanel";
import { ActivityLog, AgentCards, ChampionHistory, HeldOutPanel, Leaderboard, ParallelTimeline, RoundChart } from "./components/Panels";

const SPEEDS = [1, 2, 5, 10, 20];

function useReplay(scenario: string | null, controller: string | null, runKey: string) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!scenario || !controller) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .replay(scenario, controller)
      .then((r) => !cancelled && setReplay(r))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scenario, controller, runKey]);
  return { replay, loading, error };
}

export function App() {
  const [state, setState] = useState<PublicState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);
  const [leftId, setLeftId] = useState("baseline-fixed");
  const [rightId, setRightId] = useState("champion");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [heat, setHeat] = useState(false);
  const [rounds, setRounds] = useState(5);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [check, setCheck] = useState<string | null>(null);

  useEffect(() => {
    api.state().then(setState).catch(() => undefined);
    return subscribe(
      (s) => setState(s),
      (a) => setState((prev) => (prev ? { ...prev, ...a } : prev)),
      (m) => setToast(m),
    );
  }, []);

  const exp = state?.experiment ?? null;
  const runKey = `${exp?.runId ?? ""}:${exp?.championId ?? ""}`;
  const scenarios = state?.scenarios ?? [];

  useEffect(() => {
    if (!exp) return;
    if (!scenario || !scenarios.some((s) => s.id === scenario)) {
      const def = scenarios.find((s) => s.suite === "dev" && s.type === "bursty") ?? scenarios.find((s) => s.suite === "dev") ?? scenarios[0];
      setScenario(def?.id ?? null);
    }
  }, [exp?.runId, scenarios.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvedRight = rightId === "champion" ? exp?.championId ?? null : rightId;
  const left = useReplay(scenario, exp ? leftId : null, runKey);
  const right = useReplay(scenario, exp ? resolvedRight : null, runKey);

  const mismatch =
    left.replay && right.replay && (left.replay.scenarioId !== right.replay.scenarioId || left.replay.scenarioChecksum !== right.replay.scenarioChecksum);
  const ready = left.replay && right.replay && !mismatch && left.replay.scenarioId === scenario && right.replay.scenarioId === scenario;
  const duration = left.replay ? left.replay.horizon + left.replay.drain : 1200;

  // Shared clock for both maps.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) {
      last.current = null;
      return;
    }
    let raf = 0;
    const loop = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        const nt = Math.min(duration, prev + dt * speed);
        if (nt >= duration) setPlaying(false);
        return nt;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration]);

  useEffect(() => {
    setT(0);
  }, [scenario]);

  const leftOptions: ControllerOption[] = exp
    ? [
        { id: "baseline-fixed", label: `${exp.baselines.fixed.label}` },
        { id: "baseline-heuristic", label: `${exp.baselines.heuristic.label}` },
      ]
    : [];
  const rightOptions: ControllerOption[] = useMemo(() => {
    if (!exp) return [];
    const champLabel = exp.championHistory[exp.championHistory.length - 1]?.label ?? exp.championId;
    const opts: ControllerOption[] = [{ id: "champion", label: `★ Current champion — ${champLabel}` }];
    for (const h of exp.championHistory) opts.push({ id: h.policyId, label: `Champion after ${h.round === 0 ? "start" : `round ${h.round}`} — ${h.label}` });
    for (const c of exp.candidates) if (c.policy) opts.push({ id: c.id, label: `Candidate ${c.id} — ${c.name} (${c.status})` });
    opts.push({ id: "baseline-heuristic", label: exp.baselines.heuristic.label });
    const seen = new Set<string>();
    return opts.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  }, [exp]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setToast((e as Error).message);
    }
  }, []);

  const busy = state?.busy ?? null;
  const provider = state?.provider;
  const recorded = exp && !state?.live && exp.rounds.length > 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="logo">
            <span className="dot g" />
            <span className="dot y" />
            <span className="dot r" />
          </div>
          <div>
            <h1>GreenWave State College</h1>
            <div className="tagline">Agents propose. Simulation tests. Traffic policies improve.</div>
          </div>
        </div>
        <div className="top-badges">
          <span className="badge synth">Simplified State College network · synthetic traffic</span>
          {provider && (
            <span className={`badge ${provider.kind === "mock" ? "warn" : "ok"}`} title={provider.kind === "mock" ? "Proposals are random perturbations for pipeline testing, not Luminal agents" : provider.host}>
              {provider.kind === "mock" ? "Development provider · not Luminal" : `Agents: ${provider.label}`}
            </span>
          )}
          {recorded && <span className="badge rec">Recorded run · {exp!.runId}</span>}
        </div>
        <div className="selectors">
          <label>
            Scenario
            <select value={scenario ?? ""} onChange={(e) => setScenario(e.target.value)}>
              {(["dev", "train", "heldout"] as const).map((suite) => {
                const list = scenarios.filter((s) => s.suite === suite);
                if (!list.length) return null;
                return (
                  <optgroup key={suite} label={suite === "dev" ? "Development suite" : suite === "train" ? "Training suite" : "Held-out (unseen, after freeze)"}>
                    {list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} — {s.description} ({s.vehicles} veh)
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
        </div>
      </header>

      {busy && (
        <div className="busy-bar">
          <span className="spinner" /> {busy}
          {state?.progress && ` · round ${state.progress.round} of ${state.progress.of}`}
        </div>
      )}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      {!exp ? (
        <div className="empty-state">{busy ?? "Connecting to server…"}</div>
      ) : (
        <>
          <section className="maps">
            <MapPanel side="left" title="Baseline" replay={ready ? left.replay : null} loading={left.loading} error={left.error ?? (mismatch ? "Replay mismatch: scenarios differ" : null)} t={t} heat={heat} controllerId={leftId} options={leftOptions} onController={setLeftId} accent="#64748b" />
            <MapPanel side="right" title="Optimized" replay={ready ? right.replay : null} loading={right.loading} error={right.error} t={t} heat={heat} controllerId={rightId} options={rightOptions} onController={setRightId} accent="#22c55e" />
          </section>

          <section className="playback">
            <button className="btn primary" disabled={!ready} onClick={() => (t >= duration ? (setT(0), setPlaying(true)) : setPlaying(!playing))}>
              {playing ? "❚❚ Pause" : "▶ Play"}
            </button>
            <button className="btn" onClick={() => { setT(0); setPlaying(false); }}>↺ Restart</button>
            <input className="scrub" type="range" min={0} max={duration} step={0.5} value={t} onChange={(e) => setT(Number(e.target.value))} />
            <span className="clock mono">
              {fmtClock(t)} / {fmtClock(duration)}
              {left.replay && t > left.replay.horizon && <span className="muted"> · drain period</span>}
            </span>
            <div className="speeds">
              {SPEEDS.map((s) => (
                <button key={s} className={`btn tiny ${speed === s ? "on" : ""}`} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> Queue heat
            </label>
          </section>

          <section className="actions">
            <div className="action-group">
              <button className="btn primary big" disabled={!!busy || !!exp.heldOut} onClick={() => act(() => api.runRounds(rounds))}>
                ⟳ Run improvement rounds
              </button>
              <label className="small">
                rounds
                <input type="number" min={1} max={20} value={rounds} onChange={(e) => setRounds(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
              </label>
              {!confirmFreeze ? (
                <button className="btn warnbtn big" disabled={!!busy || !!exp.heldOut} onClick={() => setConfirmFreeze(true)}>
                  ❄ Freeze &amp; test on unseen traffic
                </button>
              ) : (
                <span className="confirm">
                  Freeze the current champion? No further optimization in this run.
                  <button className="btn warnbtn" onClick={() => { setConfirmFreeze(false); act(api.freeze); }}>Freeze &amp; test</button>
                  <button className="btn" onClick={() => setConfirmFreeze(false)}>Cancel</button>
                </span>
              )}
            </div>
            <div className="action-group right">
              <button className="btn" onClick={() => act(async () => { const r = await api.check(); setCheck(`${r.ok ? "✓" : "✗"} ${r.detail} (${r.latencyMs} ms)`); })}>Check connection</button>
              <select className="run-select" value={exp.runId} onChange={(e) => act(() => api.loadRun(e.target.value))} disabled={!!busy}>
                {(state?.runs ?? []).map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.runId} · {r.rounds} rounds · {r.candidates} cand.{r.frozen ? " · frozen" : ""}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!!busy} onClick={() => act(api.newExperiment)}>New experiment</button>
              <a className="btn" href="/api/report" download>Download report</a>
            </div>
            {check && <div className="check small">{check}</div>}
          </section>

          <section className="lower">
            <div className="panel span2">
              <h2>Agent team <span className="muted small">· three concurrent {provider?.kind === "luminal" ? "Luminal" : "development"} model calls per round</span></h2>
              <AgentCards agents={state!.agents} exp={exp} />
            </div>
            <div className="panel span2">
              <h2>Parallel agent timeline <span className="muted small">· every bar is a recorded model call; agents in a round run at the same time</span></h2>
              <ParallelTimeline exp={exp} />
            </div>
            <div className="panel">
              <h2>Improvement by round</h2>
              <RoundChart exp={exp} />
              <div className="summary-row">
                <Stat label="Fixed-time (dev)" value={fmt.s(exp.baselines.fixed.dev.aggregate.score)} />
                <Stat label="Heuristic (dev)" value={fmt.s(exp.baselines.heuristic.dev.aggregate.score)} />
                <Stat label="Champion (dev)" value={fmt.s(exp.championHistory[exp.championHistory.length - 1]?.devScore)} strong />
              </div>
              <div className="muted small">Development results are used for selection, so they are not unseen data. See held-out results below.</div>
            </div>
            <div className="panel">
              <h2>Champion history <span className="muted small">· click to replay</span></h2>
              <ChampionHistory exp={exp} selected={resolvedRight ?? ""} onSelect={(id) => setRightId(id)} />
              <details className="rule">
                <summary>Selection rule &amp; score</summary>
                <p className="small">{exp.scoreDefinition}</p>
                <ul className="small">{exp.selectionRule.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </details>
            </div>
            <div className="panel span2">
              <h2>Candidate leaderboard <span className="muted small">· training score, click a row for details</span></h2>
              <Leaderboard exp={exp} onReplay={(id) => setRightId(id)} />
            </div>
            <div className="panel span2">
              <h2>Final held-out results <span className="muted small">· unseen synthetic traffic, frozen champion</span></h2>
              <HeldOutPanel exp={exp} />
            </div>
            <div className="panel span2">
              <h2>Activity</h2>
              <ActivityLog items={state!.activity} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="stat">
      <div className={`stat-v ${strong ? "strong" : ""}`}>{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

function fmtClock(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
