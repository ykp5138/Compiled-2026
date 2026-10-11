import { useState } from "react";
import type { ActivityEvent, AgentStatus, CandidateRecord, Experiment } from "../api";
import { fmt } from "../api";

export const ROLE_COLORS: Record<string, string> = {
  corridor: "#38bdf8",
  queue: "#a78bfa",
  robustness: "#f59e0b",
};

const PHASE_LABEL: Record<string, string> = {
  idle: "Idle",
  proposing: "Proposing",
  repairing: "Repairing output",
  validating: "Validating",
  testing: "Testing",
  "dev-check": "Dev check",
  accepted: "Accepted",
  rejected: "Rejected",
  invalid: "Invalid",
  error: "Provider error",
};

export function AgentCards({ agents, exp }: { agents: AgentStatus[]; exp: Experiment | null }) {
  return (
    <div className="agent-cards">
      {agents.map((a) => {
        const cand = exp?.candidates.filter((c) => c.role === a.role).slice(-1)[0];
        const busy = ["proposing", "repairing", "validating", "testing", "dev-check"].includes(a.phase);
        return (
          <div key={a.role} className={`agent-card phase-${a.phase}`} style={{ borderTopColor: ROLE_COLORS[a.role] }}>
            <div className="agent-top">
              <span className="agent-name" style={{ color: ROLE_COLORS[a.role] }}>{a.label}</span>
              <span className={`pill pill-${a.phase}`}>
                {busy && <span className="spinner" />}
                {PHASE_LABEL[a.phase] ?? a.phase}
              </span>
            </div>
            {a.message && <div className="agent-msg">{a.message}</div>}
            {a.candidateId && cand?.id !== a.candidateId && a.name ? (
              <div className="agent-cand">
                <div className="cand-name">
                  <span className="muted">{a.candidateId.split("-")[0].toUpperCase()}</span> {a.name}
                </div>
                {a.hypothesis && <div className="cand-hyp">{a.hypothesis}</div>}
                <div className="cand-result muted">awaiting simulation results</div>
              </div>
            ) : cand ? (
              <div className="agent-cand">
                <div className="cand-name">
                  <span className="muted">R{cand.round}</span> {cand.name}
                  {cand.provider === "mock" && <span className="badge warn">dev mock</span>}
                </div>
                {cand.hypothesis && <div className="cand-hyp">{cand.hypothesis}</div>}
                <div className="cand-result">
                  {cand.train ? (
                    <>
                      train <b>{fmt.s(cand.train.aggregate.score)}</b> s/veh <span className={(cand.trainVsChampionPct ?? 0) > 0 ? "good" : "bad"}>({fmt.pct(cand.trainVsChampionPct)} vs champion)</span>
                      {cand.dev && (
                        <>
                          {" · "}dev <b>{fmt.s(cand.dev.aggregate.score)}</b>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="muted">{cand.decision[0] ?? "not tested"}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="agent-msg muted">No proposals yet.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RoundChart({ exp }: { exp: Experiment }) {
  const W = 560;
  const H = 230;
  const pad = { l: 46, r: 14, t: 14, b: 34 };
  const rounds = exp.rounds.filter((r) => r.finishedAt).length;
  const maxR = Math.max(1, rounds);
  const cands = exp.candidates.filter((c) => c.train);
  const champDevByRound: number[] = [];
  for (let r = 0; r <= rounds; r++) {
    const h = [...exp.championHistory].filter((x) => x.round <= r).pop();
    champDevByRound.push(h ? h.devScore : NaN);
  }
  const fixedDev = exp.baselines.fixed.dev.aggregate.score;
  const heurDev = exp.baselines.heuristic.dev.aggregate.score;
  const vals = [...cands.map((c) => c.train!.aggregate.score), ...champDevByRound.filter(Number.isFinite), fixedDev, heurDev];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = Math.max(1, hi - lo);
  lo -= span * 0.08;
  hi += span * 0.08;
  const x = (r: number) => pad.l + (r / maxR) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = 4;
  const step = champDevByRound.map((v, r) => `${r === 0 ? "M" : "L"}${x(r)},${y(v)}${r < champDevByRound.length - 1 ? ` L${x(r + 1)},${y(v)}` : ""}`).join(" ");
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Score by round">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = lo + ((hi - lo) * i) / ticks;
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={pad.l - 6} y={y(v) + 4} className="axis" textAnchor="end">{v.toFixed(1)}</text>
            </g>
          );
        })}
        {Array.from({ length: maxR + 1 }, (_, r) => (
          <text key={r} x={x(r)} y={H - pad.b + 16} className="axis" textAnchor="middle">{r === 0 ? "start" : `R${r}`}</text>
        ))}
        <text x={(W + pad.l) / 2} y={H - 4} className="axis" textAnchor="middle">round</text>
        <text x={12} y={pad.t + 70} className="axis" transform={`rotate(-90 12 ${pad.t + 70})`} textAnchor="middle">s / scheduled veh</text>
        <line x1={pad.l} x2={W - pad.r} y1={y(fixedDev)} y2={y(fixedDev)} className="base-fixed" />
        <text x={W - pad.r} y={y(fixedDev) - 4} className="axis" textAnchor="end">fixed-time (dev)</text>
        <line x1={pad.l} x2={W - pad.r} y1={y(heurDev)} y2={y(heurDev)} className="base-heur" />
        <text x={W - pad.r} y={y(heurDev) - 4} className="axis" textAnchor="end">heuristic (dev)</text>
        <path d={step} className="champ-line" />
        {champDevByRound.map((v, r) => (
          <circle key={r} cx={x(r)} cy={y(v)} r={3.5} className="champ-dot" />
        ))}
        {cands.map((c, i) => {
          const sameRound = cands.filter((d) => d.round === c.round);
          const j = sameRound.indexOf(c);
          return (
            <circle key={i} cx={x(c.round) + (j - (sameRound.length - 1) / 2) * 9} cy={y(c.train!.aggregate.score)} r={4.5} fill={ROLE_COLORS[c.role]} className={`cand-dot ${c.status}`}>
              <title>{`${c.id} "${c.name}" — training ${c.train!.aggregate.score.toFixed(2)} (${c.status})`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="legend">
        <span><i className="lg-line champ" /> best-so-far champion · development score</span>
        <span><i className="lg-dot" /> individual candidates · training score (colour = agent)</span>
        <span><i className="lg-line dash" /> baselines · development score</span>
      </div>
    </div>
  );
}

export function Leaderboard({ exp, onReplay }: { exp: Experiment; onReplay: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const rows = [...exp.candidates].sort((a, b) => (a.train?.aggregate.score ?? Infinity) - (b.train?.aggregate.score ?? Infinity));
  const shown = showAll ? rows : rows.slice(0, 8);
  return (
    <div className="leaderboard">
      <table>
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Agent</th>
            <th className="num">Train</th>
            <th className="num">vs champ</th>
            <th className="num">Dev</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <CandidateRow key={c.id} c={c} onReplay={onReplay} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">No candidates yet — run improvement rounds.</td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > 8 && (
        <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${rows.length}`}</button>
      )}
    </div>
  );
}

function CandidateRow({ c, onReplay }: { c: CandidateRecord; onReplay: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={`row-${c.status}`} onClick={() => setOpen(!open)}>
        <td>
          <span className="muted">{c.id}</span> {c.name}
          {c.provider === "mock" && <span className="badge warn">dev mock</span>}
        </td>
        <td style={{ color: ROLE_COLORS[c.role] }}>{c.roleLabel}</td>
        <td className="num">{fmt.s(c.train?.aggregate.score)}</td>
        <td className={`num ${(c.trainVsChampionPct ?? 0) > 0 ? "good" : "bad"}`}>{c.train ? fmt.pct(c.trainVsChampionPct) : "–"}</td>
        <td className="num">{fmt.s(c.dev?.aggregate.score)}</td>
        <td>
          <span className={`pill pill-${c.status}`}>{c.status}</span>
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={6}>
            <div className="detail-grid">
              <div>
                <div className="k">Hypothesis</div>
                <div>{c.hypothesis || "–"}</div>
                <div className="k">Changes</div>
                <div>{c.explanation || "–"}</div>
                <div className="k">Decision</div>
                <div>{c.decision.join("; ") || "–"}</div>
              </div>
              <div>
                <div className="k">Parent</div>
                <div>{c.parentId}{c.claimedParentId && c.claimedParentId !== c.parentId ? ` (claimed ${c.claimedParentId})` : ""}</div>
                {c.devComparison && (
                  <>
                    <div className="k">Dev vs champion</div>
                    <div>{fmt.pct(c.devComparison.relImprovement)} · wins {c.devComparison.wins} / losses {c.devComparison.losses}</div>
                  </>
                )}
                {c.validationErrors.length > 0 && (
                  <>
                    <div className="k">Validation ({c.repairAttempts} repair)</div>
                    <ul className="errs">{c.validationErrors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </>
                )}
                <div className="k">Model calls</div>
                <div className="mono small">
                  {c.calls.map((k, i) => (
                    <div key={i}>
                      {k.provider}/{k.model} · {(k.latencyMs / 1000).toFixed(1)} s · {k.attempts} attempt(s)
                      {k.usage ? ` · ${k.usage.promptTokens ?? "?"} in / ${k.usage.completionTokens ?? "?"} out` : ""}
                      {k.error ? ` · ${k.error}` : ""}
                    </div>
                  ))}
                </div>
                {c.policy && (
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); onReplay(c.id); }}>Replay on right map</button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ChampionHistory({ exp, selected, onSelect }: { exp: Experiment; selected: string; onSelect: (id: string) => void }) {
  return (
    <ol className="champ-history">
      {exp.championHistory.map((h, i) => (
        <li key={i} className={selected === h.policyId ? "sel" : ""} onClick={() => onSelect(h.policyId)}>
          <div className="ch-round">{h.round === 0 ? "Start" : `Round ${h.round}`}</div>
          <div className="ch-name">{h.label}</div>
          <div className="ch-scores">train {fmt.s(h.trainScore)} · dev {fmt.s(h.devScore)} s/veh</div>
          <div className="ch-reason muted">{h.reason}</div>
        </li>
      ))}
    </ol>
  );
}

export function HeldOutPanel({ exp }: { exp: Experiment }) {
  const h = exp.heldOut;
  if (!h) {
    return (
      <div className="heldout empty">
        <p>
          The final held-out suite ({exp.suiteSpecs.heldOut.count} fresh synthetic episodes across {exp.suiteSpecs.heldOut.types.join(", ")} demand) has not been generated yet.
          It is created only after the champion is frozen and is never visible to the agents or the selection loop.
        </p>
      </div>
    );
  }
  const rows: [string, string][] = [
    ["Fixed-time baseline", "baseline-fixed"],
    ["Queue-responsive heuristic", "baseline-heuristic"],
    ["Frozen champion", "champion"],
  ];
  const c = h.comparisons;
  const champLabel = exp.candidates.find((x) => x.id === h.championId)?.name ?? h.championId;
  return (
    <div className="heldout">
      <div className="muted small">
        Champion <b>{champLabel}</b> frozen {new Date(h.frozenAt).toLocaleString()} · {h.manifests.length} unseen episodes
      </div>
      <table>
        <thead>
          <tr>
            <th>Controller</th>
            <th className="num">Score (s/veh)</th>
            <th className="num">± sd</th>
            <th className="num">Completion</th>
            <th className="num">P95 wait</th>
            <th className="num">Side P95</th>
            <th className="num">Trip time*</th>
            <th className="num">Backlog</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, key]) => {
            const a = h.results[key].aggregate;
            return (
              <tr key={key} className={key === "champion" ? "hl" : ""}>
                <td>{label}</td>
                <td className="num"><b>{fmt.s(a.score)}</b></td>
                <td className="num">{fmt.s(a.scoreSd)}</td>
                <td className="num">{(a.completionFraction * 100).toFixed(1)}%</td>
                <td className="num">{fmt.s(a.p95Wait, 0)} s</td>
                <td className="num">{fmt.s(a.sideP95Wait, 0)} s</td>
                <td className="num">{fmt.s(a.meanTravelTimeCompleted, 0)} s</td>
                <td className="num">{a.externalBacklog + a.inNetwork}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted small">* mean travel time of completed trips only (completion-conditioned).</div>
      <div className="improve-grid">
        {([
          ["Champion vs fixed-time", c.championVsFixed],
          ["Champion vs heuristic", c.championVsHeuristic],
          ["Heuristic vs fixed-time", c.heuristicVsFixed],
        ] as const).map(([label, cmp]) => (
          <div key={label} className="improve">
            <div className="improve-label">{label}</div>
            <div className={`improve-val ${(cmp.relImprovement ?? 0) > 0 ? "good" : "bad"}`}>{fmt.pct(cmp.relImprovement)}</div>
            <div className="muted small">
              wins {cmp.wins} · losses {cmp.losses} · per-episode {fmt.pct(cmp.meanRel)} ± {fmt.s(cmp.sdRel, 1)} (range {fmt.s(cmp.minRel, 1)}…{fmt.s(cmp.maxRel, 1)})
            </div>
          </div>
        ))}
      </div>
      <details>
        <summary>Per-episode results</summary>
        <table className="small">
          <thead>
            <tr>
              <th>Episode</th>
              <th className="num">Fixed</th>
              <th className="num">Heuristic</th>
              <th className="num">Champion</th>
              <th className="num">vs fixed</th>
              <th className="num">vs heuristic</th>
            </tr>
          </thead>
          <tbody>
            {c.championVsFixed.perScenario.map((p, i) => {
              const hp = c.championVsHeuristic.perScenario[i];
              return (
                <tr key={p.scenarioId}>
                  <td className="mono">{p.scenarioId}</td>
                  <td className="num">{fmt.s(p.baseline)}</td>
                  <td className="num">{fmt.s(hp.baseline)}</td>
                  <td className="num">{fmt.s(p.candidate)}</td>
                  <td className={`num ${(p.rel ?? 0) > 0 ? "good" : "bad"}`}>{fmt.pct(p.rel)}</td>
                  <td className={`num ${(hp.rel ?? 0) > 0 ? "good" : "bad"}`}>{fmt.pct(hp.rel)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function ActivityLog({ items }: { items: ActivityEvent[] }) {
  return (
    <div className="activity">
      {[...items].reverse().slice(0, 40).map((e, i) => (
        <div key={i} className="act">
          <span className="mono muted">{e.at.slice(11, 19)}</span>
          {e.role && <span className="act-role" style={{ color: ROLE_COLORS[e.role] }}>{e.role}</span>}
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Parallel agent timeline, reconstructed from recorded timestamps only:
 * each bar is a real model call (start = recorded start, length = measured latency).
 */
export function ParallelTimeline({ exp }: { exp: Experiment }) {
  const rounds = exp.rounds.filter((r) => r.finishedAt);
  if (rounds.length === 0) return <div className="muted small">Run improvement rounds to see when each agent's model calls ran.</div>;
  const roles = ["corridor", "queue", "robustness"] as const;
  const data = rounds.map((r) => {
    const t0 = Date.parse(r.startedAt);
    const cands = exp.candidates.filter((c) => c.round === r.round);
    let lastCallEnd = 0;
    let sequential = 0;
    const rows = roles.map((role) => {
      const c = cands.find((x) => x.role === role);
      const segs: { start: number; end: number; repair: boolean }[] = [];
      let cursor = c ? (Date.parse(c.createdAt) - t0) / 1000 : 0;
      c?.calls.forEach((k, i) => {
        const start = k.startedAt ? (Date.parse(k.startedAt) - t0) / 1000 : cursor;
        const end = start + k.latencyMs / 1000;
        segs.push({ start, end, repair: i > 0 });
        sequential += k.latencyMs / 1000;
        cursor = end;
        lastCallEnd = Math.max(lastCallEnd, end);
      });
      return { role, cand: c, segs };
    });
    const total = (Date.parse(r.finishedAt!) - t0) / 1000;
    return { round: r.round, rows, wall: lastCallEnd, sequential, total };
  });
  const maxT = Math.max(...data.map((d) => Math.max(d.total, d.sequential)));
  const sumSeq = data.reduce((a, d) => a + d.sequential, 0);
  const sumWall = data.reduce((a, d) => a + d.wall, 0);
  const W = 1000;
  const labelW = 44;
  const statW = 210;
  const plotW = W - labelW - statW;
  const rowH = 13;
  const groupH = rowH * 3 + 14;
  const H = data.length * groupH + 26;
  const x = (t: number) => labelW + (t / maxT) * plotW;
  const ticks: number[] = [];
  for (let t = 0; t <= maxT; t += 60) ticks.push(t);
  const fmtT = (s: number) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return (
    <div className="timeline">
      <div className="tl-head">
        <div>
          <div className="tl-big">{(sumSeq / Math.max(1, sumWall)).toFixed(1)}× faster</div>
          <div className="muted small">
            {data.length} rounds of proposals took <b>{fmtT(sumWall)}</b> of wall-clock time; the same {exp.candidates.reduce((a, c) => a + c.calls.length, 0)} model calls run one after another would take <b>{fmtT(sumSeq)}</b>.
          </div>
        </div>
        <div className="legend">
          {roles.map((r) => (
            <span key={r}><i className="lg-sw" style={{ background: ROLE_COLORS[r] }} /> {r}</span>
          ))}
          <span><i className="lg-sw repair" /> repair retry</span>
          <span><i className="lg-sw sim" /> simulation + selection</span>
          <span>★ new champion</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Timeline of concurrent agent model calls per round">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} className="grid" />
            <text x={x(t)} y={H - 4} className="axis" textAnchor="middle">{t === 0 ? "round start" : `${t / 60} min`}</text>
          </g>
        ))}
        {data.map((d, gi) => {
          const y0 = gi * groupH + 4;
          return (
            <g key={d.round}>
              <text x={4} y={y0 + rowH * 1.5 + 4} className="tl-round">R{d.round}</text>
              <rect x={x(d.wall)} y={y0} width={Math.max(1, x(d.total) - x(d.wall))} height={rowH * 3 - 2} className="tl-sim" />
              {d.rows.map((row, ri) =>
                row.segs.map((s, si) => (
                  <rect key={`${ri}-${si}`} x={x(s.start)} y={y0 + ri * rowH} width={Math.max(1.5, x(s.end) - x(s.start))} height={rowH - 3} rx={2} fill={ROLE_COLORS[row.role]} opacity={s.repair ? 0.45 : 0.95}>
                    <title>{`R${d.round} ${row.cand?.roleLabel ?? row.role}${s.repair ? " (repair retry)" : ""}: ${(s.end - s.start).toFixed(0)} s model call — ${row.cand?.name ?? ""}`}</title>
                  </rect>
                )),
              )}
              {d.rows.map((row, ri) =>
                row.cand?.status === "accepted" ? (
                  <text key={`w${ri}`} x={x(row.segs[row.segs.length - 1]?.end ?? 0) + 4} y={y0 + ri * rowH + rowH - 4} className="tl-star">★</text>
                ) : null,
              )}
              <text x={W - statW + 8} y={y0 + rowH + 2} className="tl-stat">parallel {fmtT(d.wall)} · sequential {fmtT(d.sequential)}</text>
              <text x={W - statW + 8} y={y0 + rowH * 2 + 4} className="axis">{(d.sequential / Math.max(1, d.wall)).toFixed(1)}× · round total {fmtT(d.total)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
