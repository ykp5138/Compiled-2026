import { useState } from "react";
import type { ActivityEvent, AgentStatus, CandidateRecord, Experiment } from "../api";
import { api, fmt } from "../api";
import { candidateCounts, champDev, fmtDur, lineage, liveAt, roundsTable, ROLE_LABEL, ROLES, timeline, type Role } from "../derive";
import type { GW } from "../useGreenwave";

export const roleVar = (r: string) => `var(--${r})`;

const SPEEDS = [1, 5, 10, 20];

export function clock(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/* ---------- Header pieces ---------- */

export function Badges({ gw }: { gw: GW }) {
  const p = gw.provider;
  return (
    <div className="badges">
      <span className="badge">{gw.exp?.network.disclaimer ?? "Simplified network · synthetic traffic"}</span>
      {p && <span className={`badge ${p.kind === "mock" ? "warn" : ""}`}>{p.kind === "mock" ? "Development provider · not Luminal" : `Agents: Luminal · ${p.model.split("/").pop()}`}</span>}
      {gw.recorded && gw.exp && <span className="badge rec">Recorded run · {gw.exp.runId}</span>}
      <StorageBadge gw={gw} />
    </div>
  );
}

function StorageBadge({ gw }: { gw: GW }) {
  const st = gw.state?.storage;
  if (!st || st.kind === "json") return <span className="badge">Storage: local JSON</span>;
  const ok = st.connected && !st.lastError;
  return (
    <button type="button" className={`badge ${ok ? "" : "warn"}`} title={st.lastError ?? `Last sync ${st.lastSyncAt ?? "never"} · click to sync`} onClick={() => gw.act(api.sync)}>
      Storage: MongoDB {st.host.includes("mongodb.net") ? "Atlas" : st.host} · {ok ? "synced" : "offline, using local JSON"}
    </button>
  );
}

const SHORT: Record<string, string> = { "state-college": "State College", "manhattan-east-village": "Manhattan" };
export const networkShort = (id: string, name?: string) => SHORT[id] ?? name ?? id;

/** Switch the side-by-side maps between networks by loading that network's best recorded run. */
export function NetworkSwitch({ gw }: { gw: GW }) {
  const nets = gw.state?.networks ?? [];
  const runs = gw.state?.runs ?? [];
  const current = gw.exp?.networkId ?? gw.exp?.network.id ?? "state-college";
  if (nets.length < 2) return null;
  const pick = (id: string) => {
    const mine = runs.filter((r) => r.networkId === id);
    const best = [...mine].sort((a, b) => Number(b.frozen) - Number(a.frozen) || b.rounds - a.rounds || b.updatedAt.localeCompare(a.updatedAt))[0];
    if (best) gw.act(() => api.loadRun(best.runId));
    else gw.act(() => api.newExperiment(id));
  };
  return (
    <div className="net-switch" role="group" aria-label="Map">
      <span className="hint">MAP</span>
      {nets.map((n) => {
        const has = runs.some((r) => r.networkId === n.id);
        return (
          <button
            key={n.id}
            type="button"
            aria-pressed={current === n.id}
            className={current === n.id ? "on" : ""}
            disabled={!!gw.busy}
            title={has ? `Load the best recorded ${n.name} run` : `No ${n.name} run yet: starts a new experiment (calibration takes about a minute)`}
            onClick={() => current !== n.id && pick(n.id)}
          >
            {networkShort(n.id, n.name)}
          </button>
        );
      })}
    </div>
  );
}

export function ScenarioSelect({ gw, label = "Scenario" }: { gw: GW; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={gw.scenario ?? ""} onChange={(e) => gw.setScenario(e.target.value)}>
        {(["dev", "heldout", "train"] as const).map((suite) => {
          const list = gw.scenarios.filter((s) => s.suite === suite);
          if (!list.length) return null;
          return (
            <optgroup key={suite} label={suite === "dev" ? "Development suite" : suite === "train" ? "Training suite" : "Held-out (unseen)"}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.type} · {s.vehicles} veh
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

export function UtilityButtons({ gw }: { gw: GW }) {
  const exp = gw.exp;
  return (
    <div className="util">
      <NetworkSwitch gw={gw} />
      <button type="button" className="btn" onClick={gw.runCheck}>Check connection</button>
      {exp && (
        <select aria-label="Recorded run" value={exp.runId} disabled={!!gw.busy} onChange={(e) => gw.act(() => api.loadRun(e.target.value))}>
          {(gw.state?.runs ?? []).map((r) => (
            <option key={r.runId} value={r.runId}>
              {networkShort(r.networkId, r.networkName)} · {r.runId} · {r.rounds} rounds{r.frozen ? " · frozen" : ""}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Network for a new experiment" value={gw.newNetwork} onChange={(e) => gw.setNewNetwork(e.target.value)} disabled={!!gw.busy}>
        {(gw.state?.networks ?? []).map((n) => (
          <option key={n.id} value={n.id}>{n.name} · {n.signals} signals</option>
        ))}
      </select>
      <button type="button" className="btn" disabled={!!gw.busy} onClick={() => gw.act(() => api.newExperiment(gw.newNetwork))}>New experiment</button>
      <a className="btn" href="/api/report" download>Download report</a>
    </div>
  );
}

export function RunControls({ gw }: { gw: GW }) {
  const [confirm, setConfirm] = useState(false);
  const exp = gw.exp;
  if (!exp) return null;
  const frozen = !!exp.heldOut;
  if (frozen) {
    const open = (gw.state?.runs ?? []).find((r) => !r.frozen);
    return (
      <div className="run-controls">
        <span className="frozen-note">This run is frozen and tested on unseen traffic, so it can't be optimized further.</span>
        {open ? (
          <button type="button" className="btn primary" disabled={!!gw.busy} onClick={() => gw.act(() => api.loadRun(open.runId))}>
            Switch to open run {open.runId} ({open.rounds} rounds)
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!!gw.busy} onClick={() => gw.act(() => api.newExperiment(gw.newNetwork))}>
            Start a new experiment
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="run-controls">
      <label className="field">
        <span>Rounds</span>
        <input type="number" min={1} max={20} value={gw.rounds} onChange={(e) => gw.setRounds(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
      </label>
      <button type="button" className="btn primary" disabled={!!gw.busy || frozen} onClick={() => gw.act(() => api.runRounds(gw.rounds))}>
        Run improvement rounds
      </button>
      {!confirm ? (
        <button type="button" className="btn outline-accent" disabled={!!gw.busy || frozen} onClick={() => setConfirm(true)}>
          Freeze &amp; test on unseen traffic
        </button>
      ) : (
        <span className="confirm">
          Freeze the champion? This run can't be optimized further.
          <button type="button" className="btn outline-accent" onClick={() => { setConfirm(false); gw.act(api.freeze); }}>Freeze &amp; test</button>
          <button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      )}
      {frozen && <span className="hint">Frozen · start a new experiment to optimize again</span>}
    </div>
  );
}

export function Notices({ gw }: { gw: GW }) {
  return (
    <>
      {gw.busy && (
        <div className="busy-bar" role="status">
          <span className="spinner" aria-hidden="true" /> {gw.busy}
          {gw.state?.progress && ` · round ${gw.state.progress.round} of ${gw.state.progress.of}`}
        </div>
      )}
      {gw.check && <div className="check" role="status">{gw.check}</div>}
      {gw.toast && (
        <button type="button" className="toast" onClick={() => gw.setToast(null)}>
          {gw.toast} · dismiss
        </button>
      )}
    </>
  );
}

/* ---------- Playback ---------- */

export function PlaybackBar({ gw, compact }: { gw: GW; compact?: boolean }) {
  return (
    <section className={`playback ${compact ? "compact" : ""}`} aria-label="Playback">
      <button type="button" className="btn icon" aria-label="Restart" onClick={() => { gw.setT(0); gw.setPlaying(false); }}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
      </button>
      <button type="button" className="btn icon play" aria-label={gw.playing ? "Pause" : "Play"} disabled={!gw.ready} onClick={gw.togglePlay}>
        {gw.playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M6 4.5h4v15H6zM14 4.5h4v15h-4z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>
        )}
      </button>
      <label htmlFor={`scrub-${compact ? "c" : "f"}`} className="hint">REPLAY</label>
      <input id={`scrub-${compact ? "c" : "f"}`} className="scrub" type="range" min={0} max={gw.duration} step={0.5} value={gw.t} onChange={(e) => gw.setT(Number(e.target.value))} />
      <span className="clock">
        {clock(gw.t)} <span className="muted">/ {clock(gw.duration)}</span>
        {gw.left.replay && gw.t > gw.left.replay.horizon && <span className="muted"> · drain</span>}
      </span>
      <div className="speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" aria-pressed={gw.speed === s} className={`btn speed ${gw.speed === s ? "on" : ""}`} onClick={() => gw.setSpeed(s)}>{s}×</button>
        ))}
      </div>
      <button type="button" aria-pressed={gw.heat} className={`btn heat ${gw.heat ? "on" : ""}`} onClick={() => gw.setHeat(!gw.heat)}>
        <span className="heat-dot" aria-hidden="true" /> Queue heat
      </button>
    </section>
  );
}

/* ---------- Head-to-head scoreboard (live) ---------- */

export function Scoreboard({ gw }: { gw: GW }) {
  const L = liveAt(gw.left.replay, gw.t);
  const R = liveAt(gw.right.replay, gw.t);
  const rows: { label: string; l: number | null; r: number | null; f: (x: number) => string; lowerBetter: boolean }[] = [
    { label: "Stopped s / scheduled veh", l: L?.stoppedPerVeh ?? null, r: R?.stoppedPerVeh ?? null, f: (x) => x.toFixed(1), lowerBetter: true },
    { label: "Trips completed", l: L?.completed ?? null, r: R?.completed ?? null, f: (x) => String(x), lowerBetter: false },
    { label: "Waiting now", l: L?.waiting ?? null, r: R?.waiting ?? null, f: (x) => String(x), lowerBetter: true },
    { label: "P95 wait (s)", l: L?.p95 ?? null, r: R?.p95 ?? null, f: (x) => x.toFixed(0), lowerBetter: true },
  ];
  const pct = L && R && L.stoppedPerVeh > 0 ? (100 * (L.stoppedPerVeh - R.stoppedPerVeh)) / L.stoppedPerVeh : null;
  return (
    <section className="scoreboard" aria-label="Head-to-head scoreboard">
      <h2 className="label">Head to head</h2>
      <div className="sb-clock">{clock(gw.t)}</div>
      {rows.map((row) => {
        const lb = row.l !== null && row.r !== null && (row.lowerBetter ? row.l < row.r : row.l > row.r);
        const rb = row.l !== null && row.r !== null && (row.lowerBetter ? row.r < row.l : row.r > row.l);
        return (
          <div className="sb-row" key={row.label}>
            <div className={`sb-v ${lb ? "better" : ""}`}>{row.l === null ? "–" : row.f(row.l)}</div>
            <div className="sb-l">{row.label}</div>
            <div className={`sb-v ${rb ? "better" : ""}`}>{row.r === null ? "–" : row.f(row.r)}</div>
          </div>
        );
      })}
      <div className="sb-meter">
        <div className="sb-meter-l">Champion so far</div>
        <div className={`sb-meter-v ${pct !== null && pct > 0 ? "good" : pct !== null && pct < 0 ? "bad" : ""}`}>{pct === null || gw.t < 30 ? "–" : `${pct >= 0 ? "" : "−"}${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? "less" : "more"} stopping`}</div>
      </div>
    </section>
  );
}

/* ---------- Agents ---------- */

const RUNNING = ["proposing", "repairing", "validating", "testing", "dev-check"];
const PHASE: Record<string, string> = { idle: "Idle", proposing: "Proposing", repairing: "Repairing output", validating: "Validating", testing: "Testing", "dev-check": "Dev check", accepted: "Accepted", rejected: "Rejected", invalid: "Invalid", error: "Provider error" };

export function AgentGrid({ agents, exp, detailed }: { agents: AgentStatus[]; exp: Experiment | null; detailed?: boolean }) {
  return (
    <div className="agent-grid">
      {agents.map((a) => {
        const cand = exp?.candidates.filter((c) => (c.agentId ?? c.role) === a.agentId).slice(-1)[0];
        const pending = a.candidateId && cand?.id !== a.candidateId;
        const run = RUNNING.includes(a.phase);
        const ok = a.phase === "accepted";
        const no = ["rejected", "invalid", "error"].includes(a.phase);
        const shown = pending ? { name: a.name, hyp: a.hypothesis } : cand ? { name: cand.name, hyp: cand.hypothesis } : null;
        return (
          <div key={a.agentId} className={`agent phase-${a.phase}`} title={a.message ?? ""}>
            <div className="agent-row">
              <div className="agent-role"><span className="sq" style={{ background: roleVar(a.role) }} /><span>{a.label.split(" · ")[0]}</span></div>
              <span className="variant" style={{ color: roleVar(a.role) }}>{a.variant}</span>
            </div>
            <div className={`agent-status ${ok ? "ok" : no ? "no" : ""}`}>
              {run && <span className="spinner" aria-hidden="true" style={{ color: roleVar(a.role) }} />}
              {ok && <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12.5l5 5L20 6.5" /></svg>}
              {no && <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>}
              <span>{PHASE[a.phase] ?? a.phase}</span>
            </div>
            {shown?.name && <div className="agent-cand">{shown.name}</div>}
            {detailed && shown?.hyp && <div className="agent-hyp">{shown.hyp}</div>}
            {!pending && cand?.train && (
              <div className="agent-res">
                train {fmt.s(cand.train.aggregate.score)} ({fmt.pct(cand.trainVsChampionPct)}){cand.dev ? ` · dev ${fmt.s(cand.dev.aggregate.score)}` : ""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AgentsHeader({ gw }: { gw: GW }) {
  const n = gw.state?.agents.length ?? 0;
  return (
    <div className="panel-head-left">
      <h2 className="label">Agents</h2>
      <span className="sub">{n === 6 ? "3 roles × 2 variants = 6 in parallel" : `${n} in parallel`}</span>
      <span className="hint">Proposing → Validating → Repairing output → Testing → Dev check → Accepted / Rejected / Invalid</span>
    </div>
  );
}

/* ---------- Parallel timeline ---------- */

export function TimelineTotals({ exp }: { exp: Experiment }) {
  const tl = timeline(exp);
  if (!tl.rounds.length) return null;
  return (
    <div className="tl-totals">
      <span className="sub">{fmtDur(tl.wall)} parallel</span>
      <span className="muted">{fmtDur(tl.seq)} sequential</span>
      <span className="tl-big">{(tl.seq / Math.max(1, tl.wall)).toFixed(1)}×</span>
    </div>
  );
}

export function TimelineLegend() {
  return (
    <>
      {ROLES.map((r) => (
        <span key={r} className="legend-sw"><i style={{ background: roleVar(r) }} />{ROLE_LABEL[r]}</span>
      ))}
      <span className="hint">hatched = repair call · ★ = accepted</span>
    </>
  );
}

export function Timeline({ exp }: { exp: Experiment }) {
  const tl = timeline(exp);
  if (!tl.rounds.length) return <p className="note">Run improvement rounds to see every agent's model calls side by side.</p>;
  return (
    <div className="tl-scroll">
      <div className="tl-rounds">
        {tl.rounds.map((r) => (
          <div key={r.n} className="tl-round" style={{ flex: `${Math.max(60, r.total)} 1 0px` }}>
            <div className="tl-round-head"><b>R{r.n}</b><span>{Math.round(r.total)} s</span><span>{(r.seq / Math.max(1, r.wall)).toFixed(1)}×</span></div>
            {r.rows.map((row) => (
              <div key={row.key} className="tl-row" title={`${row.key}: ${Math.round(row.main)} s${row.rep ? ` + ${Math.round(row.rep)} s repair` : ""} · ${row.name}`}>
                <div className="tl-bar" style={{ width: `${(((row.main + row.rep) / Math.max(1, r.total)) * 100).toFixed(1)}%` }}>
                  <span style={{ flexGrow: row.main, background: roleVar(row.role) }} />
                  {row.rep > 0 && <span style={{ flexGrow: row.rep, background: `repeating-linear-gradient(135deg, ${roleVar(row.role)} 0 2px, transparent 2px 5px)` }} />}
                </div>
                <span className={row.accepted ? "good" : "sub"}>
                  {Math.round(row.main)}
                  {row.rep ? ` +${Math.round(row.rep)}` : ""}
                  {row.accepted ? " ★" : ""}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Rounds table & chart ---------- */

export function RoundsTable({ exp }: { exp: Experiment }) {
  const rows = roundsTable(exp);
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Round</th>
            {ROLES.map((r) => <th scope="col" key={r} style={{ color: roleVar(r) }}>{ROLE_LABEL[r]}</th>)}
            <th scope="col">Champion · dev</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              {ROLES.map((r) => {
                const v = row.perRole[r];
                return <td key={r} className={v?.accepted ? "win" : v ? "" : "dim"}>{v ? `${v.score.toFixed(2)}${v.accepted ? " ★" : ""}` : "–"}</td>;
              })}
              <td className={row.changed ? "win" : row.round === 0 ? "" : "dim"}>{fmt.s(row.champDev)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImprovementChart({ exp, height = 240 }: { exp: Experiment; height?: number }) {
  const W = 620;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const rows = roundsTable(exp);
  const maxR = Math.max(1, rows.length - 1);
  const cands = exp.candidates.filter((c) => c.train);
  const fixedDev = exp.baselines.fixed.dev.aggregate.score;
  const heurDev = exp.baselines.heuristic.dev.aggregate.score;
  const vals = [...cands.map((c) => c.train!.aggregate.score), ...rows.map((r) => r.champDev), ...rows.map((r) => r.champTrain), fixedDev, heurDev].filter(Number.isFinite);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  // "Nice" tick step (1, 2, 2.5 or 5 × 10^k) so axis labels are round numbers.
  const raw = Math.max(0.5, (hi0 - lo0) / 4);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const tickStep = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw)!;
  const lo = Math.floor(lo0 / tickStep) * tickStep;
  const hi = Math.ceil(hi0 / tickStep) * tickStep;
  const x = (r: number) => pad.l + (r / maxR) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const stepPath = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}${i < vals.length - 1 ? ` L${x(i + 1)},${y(v)}` : ""}`).join(" ");
  const step = stepPath(rows.map((r) => r.champDev));
  const stepTrain = stepPath(rows.map((r) => r.champTrain));
  const ticks = Math.round((hi - lo) / tickStep);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Champion development score and candidate training scores by round">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = lo + ((hi - lo) * i) / ticks;
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={pad.l - 6} y={y(v) + 4} className="axis" textAnchor="end">{Number.isInteger(v) ? v : v.toFixed(1)}</text>
            </g>
          );
        })}
        {rows.map((r, i) => <text key={i} x={x(i)} y={H - 6} className="axis" textAnchor="middle">{r.label === "Start" ? "start" : r.label}</text>)}
        {[["fixed-time", fixedDev], ["heuristic", heurDev]].map(([l, v]) => (
          <g key={l as string}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v as number)} y2={y(v as number)} className="base" />
            <text x={W - pad.r} y={y(v as number) - 4} className="axis" textAnchor="end">{l} {(v as number).toFixed(2)}</text>
          </g>
        ))}
        <path d={stepTrain} className="champ-train-line" />
        <path d={step} className="champ-line" />
        {rows.map((r, i) => <circle key={i} cx={x(i)} cy={y(r.champDev)} r={3.5} className="champ-dot" />)}
        {cands.map((c) => {
          const same = cands.filter((d) => d.round === c.round);
          const j = same.indexOf(c);
          return (
            <circle key={c.id} cx={x(c.round) + (j - (same.length - 1) / 2) * 7} cy={y(c.train!.aggregate.score)} r={4} style={{ fill: roleVar(c.role) }} className={`cand-dot ${c.status}`}>
              <title>{`${c.id} "${c.name}" training ${c.train!.aggregate.score.toFixed(2)} (${c.status})`}</title>
            </circle>
          );
        })}
      </svg>
      <figcaption className="legend">
        <span className="legend-sw"><i className="lg-line" />Champion · development</span>
        <span className="legend-sw"><i className="lg-line dashed" />Champion · training</span>
        <span className="legend-sw"><i className="lg-dot" />Candidates · training (compare to dashed line)</span>
        <span className="legend-sw"><i className="lg-dash" />Baselines · development</span>
      </figcaption>
    </figure>
  );
}

/* ---------- Held-out ---------- */

export function HeldOutTables({ exp }: { exp: Experiment }) {
  const h = exp.heldOut;
  if (!h) {
    return (
      <p className="note">
        Not run yet. {exp.suiteSpecs.heldOut.count} fresh synthetic episodes are generated only after the champion is frozen, and they are never shown to the agents or the selection loop.
      </p>
    );
  }
  const rows: [string, string][] = [["Fixed-time", "baseline-fixed"], ["Heuristic", "baseline-heuristic"], ["Champion · frozen", "champion"]];
  const c = h.comparisons;
  return (
    <>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th scope="col">Policy</th><th scope="col">Stopped s/veh</th><th scope="col">Completion</th><th scope="col">P95</th><th scope="col">Side P95</th><th scope="col">Unfinished</th></tr>
          </thead>
          <tbody>
            {rows.map(([label, key]) => {
              const a = h.results[key].aggregate;
              return (
                <tr key={key} className={key === "champion" ? "hl" : ""}>
                  <td>{label}</td>
                  <td>{a.score.toFixed(2)} ± {a.scoreSd.toFixed(2)}</td>
                  <td>{(a.completionFraction * 100).toFixed(1)}%</td>
                  <td>{a.p95Wait.toFixed(0)} s</td>
                  <td>{a.sideP95Wait.toFixed(0)} s</td>
                  <td>{a.externalBacklog + a.inNetwork}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th scope="col">Comparison</th><th scope="col">Better by</th><th scope="col">Wins / losses</th><th scope="col">Per episode</th></tr>
          </thead>
          <tbody>
            {([["Champion vs heuristic", c.championVsHeuristic, true], ["Champion vs fixed-time", c.championVsFixed, true], ["Heuristic vs fixed-time", c.heuristicVsFixed, false]] as const).map(([l, cmp, hl]) => (
              <tr key={l}>
                <td>{l}</td>
                <td className={hl ? "win" : ""}>{fmt.pct(cmp.relImprovement)}</td>
                <td>{cmp.wins} / {cmp.losses}</td>
                <td>{fmt.pct(cmp.minRel)} … {fmt.pct(cmp.maxRel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- Rule & lineage ---------- */

export function SelectionRule() {
  return (
    <ol className="rule-list">
      <li>Beat the champion on training.</li>
      <li>Be ≥ 1% better on the development suite.</li>
      <li>Win ≥ half the paired episodes.</li>
      <li>Not worsen completion, side-street P95 or overall P95.</li>
    </ol>
  );
}

export function Lineage({ exp, selected, onSelect, long }: { exp: Experiment; selected: string; onSelect: (id: string) => void; long?: boolean }) {
  const items = lineage(exp);
  return (
    <div className="lineage">
      {items.map((l, i) => (
        <button type="button" key={l.policyId} className={`lin-item ${selected === l.policyId ? "sel" : ""}`} onClick={() => onSelect(l.policyId)} title="Replay this champion on the right map">
          <span className="lin-top">
            <span className="lin-name">{i === 0 ? l.label : `↳ ${l.label}`}</span>
            <span className={i === items.length - 1 && i > 0 ? "good" : "muted"}>dev {l.devScore.toFixed(2)}</span>
          </span>
          <span className="lin-role" style={{ color: l.role ? roleVar(l.role) : undefined }}>{l.round === 0 ? "Starting champion · stronger baseline on dev" : `Round ${l.round} · ${l.agentLabel ?? ""}`}</span>
          {l.hypothesis && <span className="lin-hyp">“{long ? l.hypothesis : l.hypothesis.length > 170 ? `${l.hypothesis.slice(0, 170)}…` : l.hypothesis}”</span>}
        </button>
      ))}
    </div>
  );
}

export function CountsLine({ exp }: { exp: Experiment }) {
  const c = candidateCounts(exp);
  return (
    <span className="hint">
      {c.total} candidates · {c.accepted} accepted · {c.rejected} failed dev rule · {c.screened} screened out on training · {c.invalid} invalid
    </span>
  );
}

export function DevBaselines({ exp }: { exp: Experiment }) {
  return (
    <p className="note mono">
      Baselines on development: fixed-time {exp.baselines.fixed.dev.aggregate.score.toFixed(2)} · heuristic {exp.baselines.heuristic.dev.aggregate.score.toFixed(2)} · champion {champDev(exp).toFixed(2)}
    </p>
  );
}

/* ---------- Leaderboard & activity ---------- */

export function Leaderboard({ exp, onReplay }: { exp: Experiment; onReplay: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = [...exp.candidates].sort((a, b) => (a.train?.aggregate.score ?? Infinity) - (b.train?.aggregate.score ?? Infinity));
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <div className="leaderboard tbl-wrap">
      <table>
        <thead>
          <tr><th scope="col">Candidate</th><th scope="col">Agent</th><th scope="col">Train</th><th scope="col">vs champ</th><th scope="col">Dev</th><th scope="col">Status</th></tr>
        </thead>
        <tbody>
          {shown.map((c) => <CandidateRow key={c.id} c={c} onReplay={onReplay} />)}
          {!rows.length && <tr><td colSpan={6} className="dim">No candidates yet.</td></tr>}
        </tbody>
      </table>
      {rows.length > 10 && <button type="button" className="link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </div>
  );
}

function CandidateRow({ c, onReplay }: { c: CandidateRecord; onReplay: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen(!open)}>
        <td><span className="muted">{c.id}</span> {c.name}</td>
        <td style={{ color: roleVar(c.role) }}>{c.roleLabel}</td>
        <td>{fmt.s(c.train?.aggregate.score)}</td>
        <td className={(c.trainVsChampionPct ?? 0) > 0 ? "win" : "dim"}>{c.train ? fmt.pct(c.trainVsChampionPct) : "–"}</td>
        <td>{fmt.s(c.dev?.aggregate.score)}</td>
        <td><span className={`status ${c.status}`}>{c.status}</span></td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={6}>
            <div className="detail-grid">
              <div>
                <div className="k">Hypothesis</div><div>{c.hypothesis || "–"}</div>
                <div className="k">Changes</div><div>{c.explanation || "–"}</div>
                <div className="k">Decision</div><div>{c.decision.join("; ") || "–"}</div>
              </div>
              <div>
                <div className="k">Parent</div><div>{c.parentId}</div>
                {c.validationErrors.length > 0 && (<><div className="k">Validation ({c.repairAttempts} repair)</div><ul className="errs">{c.validationErrors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}</ul></>)}
                <div className="k">Model calls</div>
                <div className="mono small">{c.calls.map((k, i) => <div key={i}>{k.model} · {(k.latencyMs / 1000).toFixed(1)} s{k.usage ? ` · ${k.usage.completionTokens ?? "?"} out` : ""}{k.error ? ` · ${k.error}` : ""}</div>)}</div>
                {c.policy && <button type="button" className="btn small" onClick={(e) => { e.stopPropagation(); onReplay(c.id); }}>Replay on right map</button>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ActivityLog({ items }: { items: ActivityEvent[] }) {
  return (
    <div className="activity">
      {[...items].reverse().slice(0, 60).map((e, i) => (
        <div key={i} className="act">
          <span className="mono muted">{e.at.slice(11, 19)}</span>
          {e.role && <span className="act-role" style={{ color: roleVar(e.role) }}>{e.agent ?? e.role}</span>}
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function MoreDetails({ gw }: { gw: GW }) {
  if (!gw.exp) return null;
  return (
    <details className="more">
      <summary>All candidates &amp; activity log</summary>
      <div className="more-grid">
        <Leaderboard exp={gw.exp} onReplay={(id) => gw.setRightId(id)} />
        <ActivityLog items={gw.state?.activity ?? []} />
      </div>
    </details>
  );
}

export type { Role };
