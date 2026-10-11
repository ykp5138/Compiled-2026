// Four layouts from the Claude Design canvas "GreenWave State College · four directions".
// All share the same live data, replays and controls (useGreenwave); only arrangement and theme differ.
import { useState } from "react";
import type { CandidateRecord, Experiment } from "./api";
import { fmt } from "./api";
import { MapPanel } from "./components/MapPanel";
import {
  AgentGrid,
  AgentsHeader,
  Badges,
  CountsLine,
  DevBaselines,
  HeldOutTables,
  ImprovementChart,
  Lineage,
  MoreDetails,
  ActivityLog,
  Leaderboard,
  Notices,
  PlaybackBar,
  roleVar,
  RoundsTable,
  RunControls,
  ScenarioSelect,
  Scoreboard,
  SelectionRule,
  Timeline,
  TimelineLegend,
  TimelineTotals,
  UtilityButtons,
} from "./components/kit";
import { candidateCounts, champDev, fmtDur, lineage, timeline } from "./derive";
import { PALETTES } from "./render/mapRenderer";
import type { GW } from "./useGreenwave";

function Maps({ gw, theme, bare }: { gw: GW; theme: string; bare?: boolean }) {
  const p = PALETTES[theme];
  return (
    <>
      <MapPanel side="left" tag="BASELINE" replay={gw.ready ? gw.left.replay : null} loading={gw.left.loading} error={gw.left.error ?? (gw.mismatch ? "Replay mismatch: scenarios differ" : null)} t={gw.t} heat={gw.heat} palette={p} controllerId={gw.leftId} options={gw.leftOptions} onController={gw.setLeftId} bare={bare} />
      <MapPanel side="right" tag="AGENT CHAMPION" replay={gw.ready ? gw.right.replay : null} loading={gw.right.loading} error={gw.right.error} t={gw.t} heat={gw.heat} palette={p} controllerId={gw.rightId} options={gw.rightOptions} onController={gw.setRightId} bare={bare} />
    </>
  );
}

/* ================= A · Ops command center ================= */

export function OpsLayout({ gw }: { gw: GW }) {
  const exp = gw.exp!;
  return (
    <div className="app ops">
      <header className="top">
        <div className="top-left">
          <h1>GreenWave State College</h1>
          <p className="tagline">Agents propose. Simulation tests. Traffic policies improve.</p>
          <Badges gw={gw} />
        </div>
        <div className="top-right">
          <ScenarioSelect gw={gw} />
          <UtilityButtons gw={gw} />
        </div>
      </header>
      <Notices gw={gw} />
      <section className="maps" aria-label="Synchronized replay"><Maps gw={gw} theme="a" /></section>
      <PlaybackBar gw={gw} />
      <section className="panel" aria-label="Agents">
        <div className="panel-head"><AgentsHeader gw={gw} /><RunControls gw={gw} /></div>
        <AgentGrid agents={gw.state!.agents} exp={exp} />
      </section>
      <section className="panel" aria-label="Parallel timeline">
        <div className="panel-head">
          <div className="panel-head-left">
            <h2 className="label">Parallel timeline</h2>
            <span className="sub">Every call in a round starts together · seconds per call</span>
            <TimelineLegend />
          </div>
          <TimelineTotals exp={exp} />
        </div>
        <Timeline exp={exp} />
      </section>
      <section className="results" aria-label="Results">
        <div className="panel dev">
          <div className="panel-head-left"><span className="suite-tag dev">DEVELOPMENT</span><h2 className="h-small">Rounds</h2><span className="muted">seconds stopped per scheduled vehicle · lower is better</span></div>
          <RoundsTable exp={exp} />
          <p className="note">Role columns are each role's best candidate training score; the last column is the champion on the development suite. ★ accepted.</p>
          <DevBaselines exp={exp} />
          <CountsLine exp={exp} />
        </div>
        <div className="panel heldout">
          <div className="panel-head-left"><span className="suite-tag held">HELD-OUT</span><h2 className="h-small">Unseen traffic</h2><span className="muted">champion frozen first · {exp.suiteSpecs.heldOut.count} unseen episodes</span></div>
          <HeldOutTables exp={exp} />
        </div>
        <div className="panel rule">
          <h2 className="label">Selection rule</h2>
          <SelectionRule />
          <h2 className="label">Champion lineage</h2>
          <Lineage exp={exp} selected={gw.resolvedRight ?? ""} onSelect={gw.setRightId} />
        </div>
      </section>
      <MoreDetails gw={gw} />
    </div>
  );
}

/* ================= B · Story mode ================= */

export function StoryLayout({ gw }: { gw: GW }) {
  const exp = gw.exp!;
  const tl = timeline(exp);
  const h = exp.heldOut;
  const counts = candidateCounts(exp);
  const nAgents = gw.state?.agents.length ?? 0;
  const lin = lineage(exp);
  const fixed = exp.baselines.fixed.dev.aggregate.score;
  const heur = exp.baselines.heuristic.dev.aggregate.score;
  return (
    <div className="app story">
      <header className="story-hero">
        <p className="kicker">Track 1 · Self-improving agent team</p>
        <h1>GreenWave <em>State College</em></h1>
        <p className="lede">Agents propose. Simulation tests. Traffic policies improve.</p>
        <Badges gw={gw} />
      </header>
      <Notices gw={gw} />

      <section className="chapter" aria-labelledby="ch1">
        <div className="ch-head"><span className="ch-num">01</span><h2 id="ch1">The problem</h2></div>
        <p className="ch-text">Six signals in downtown State College: College Avenue one-way west, Beaver Avenue one-way east, crossed by Atherton, Allen and Pugh. Both maps below replay the same pre-generated synthetic traffic. Only the signal policy differs.</p>
        <div className="story-controls"><ScenarioSelect gw={gw} /></div>
        <div className="maps"><Maps gw={gw} theme="b" /></div>
        <PlaybackBar gw={gw} />
      </section>

      <section className="chapter" aria-labelledby="ch2">
        <div className="ch-head"><span className="ch-num">02</span><h2 id="ch2">The baseline</h2></div>
        <p className="ch-text">Two honest baselines, both calibrated on training traffic only: a Webster fixed-time plan with green-wave offsets, and a queue-responsive heuristic. The heuristic is the starting champion the agents have to beat.</p>
        <div className="stat-row">
          <div className="stat-card"><div className="stat-l">Fixed-time · development</div><div className="stat-big">{fixed.toFixed(2)}<span> s</span></div><div className="stat-s">stopped per scheduled vehicle</div></div>
          <div className="stat-card"><div className="stat-l">Queue-responsive heuristic · development</div><div className="stat-big">{heur.toFixed(2)}<span> s</span></div><div className="stat-s">{fmt.pct(((fixed - heur) / fixed) * 100)} vs fixed-time · starting champion</div></div>
        </div>
      </section>

      <section className="chapter" aria-labelledby="ch3">
        <div className="ch-head"><span className="ch-num">03</span><h2 id="ch3">{nAgents === 6 ? "Six agents, in parallel" : `${nAgents} agents, in parallel`}</h2></div>
        <p className="ch-text">Each round, every agent proposes one JSON signal policy at the same time: three roles, each with a careful <b>refine</b> and a bolder <b>explore</b> variant. Ordinary code validates, simulates and selects; results and lessons feed the next round.</p>
        {tl.rounds.length > 0 && (
          <div className="big-claim"><span className="big-num">{(tl.seq / Math.max(1, tl.wall)).toFixed(1)}×</span><span className="big-text">faster than one-at-a-time: {tl.calls} model calls took {fmtDur(tl.wall)} instead of {fmtDur(tl.seq)}.</span></div>
        )}
        <div className="panel"><div className="panel-head"><AgentsHeader gw={gw} /><RunControls gw={gw} /></div><AgentGrid agents={gw.state!.agents} exp={exp} detailed /></div>
        <div className="panel"><div className="panel-head"><div className="panel-head-left"><h3 className="label">Parallel timeline</h3><TimelineLegend /></div><TimelineTotals exp={exp} /></div><Timeline exp={exp} /></div>
      </section>

      <section className="chapter" aria-labelledby="ch4">
        <div className="ch-head"><span className="ch-num">04</span><h2 id="ch4">Getting better every round</h2></div>
        <p className="ch-text">{counts.total} candidates so far: {counts.accepted} became champion, {counts.rejected} looked good on training but failed the development rule, {counts.screened} didn't beat the champion on training. Each champion builds on the one before it.</p>
        <div className="two-col">
          <div className="panel"><ImprovementChart exp={exp} height={280} /></div>
          <div className="panel"><h3 className="label">Champion lineage</h3><Lineage exp={exp} selected={gw.resolvedRight ?? ""} onSelect={gw.setRightId} long /></div>
        </div>
        {lin.length > 1 && <p className="ch-text small-note">Development score: {lin[0].devScore.toFixed(2)} → {lin[lin.length - 1].devScore.toFixed(2)} s. Development data is used for selection, so it is not unseen.</p>}
      </section>

      <section className="chapter proof" aria-labelledby="ch5">
        <div className="ch-head"><span className="ch-num">05</span><h2 id="ch5">Proof on unseen traffic</h2></div>
        {h ? (
          <>
            <div className="big-claim center">
              <span className="giant">{fmt.pct(h.comparisons.championVsHeuristic.relImprovement)}</span>
              <span className="big-text">less stopping than the heuristic on {h.manifests.length} episodes the agents never saw · {h.comparisons.championVsHeuristic.wins} wins, {h.comparisons.championVsHeuristic.losses} losses · {fmt.pct(h.comparisons.championVsFixed.relImprovement)} vs fixed-time</span>
            </div>
            <div className="panel"><HeldOutTables exp={exp} /></div>
          </>
        ) : (
          <div className="panel"><HeldOutTables exp={exp} /><RunControls gw={gw} /></div>
        )}
      </section>

      <footer className="story-foot"><UtilityButtons gw={gw} /><MoreDetails gw={gw} /></footer>
    </div>
  );
}

/* ================= C · Split-screen versus ================= */

export function VersusLayout({ gw }: { gw: GW }) {
  const exp = gw.exp!;
  const [tab, setTab] = useState<"agents" | "rounds" | "proof" | "log">("agents");
  const [open, setOpen] = useState(true);
  const tabs: [typeof tab, string][] = [["agents", "Agents"], ["rounds", "Rounds"], ["proof", "Held-out proof"], ["log", "Candidates & log"]];
  return (
    <div className="app versus">
      <header className="vs-top">
        <div className="vs-brand"><h1>GreenWave State College</h1><Badges gw={gw} /></div>
        <div className="top-right"><ScenarioSelect gw={gw} /><UtilityButtons gw={gw} /></div>
      </header>
      <Notices gw={gw} />
      <section className="vs-stage" aria-label="Baseline versus agent champion">
        <div className="vs-map"><Maps gw={gw} theme="c" bare /></div>
      </section>
      <section className="vs-board"><Scoreboard gw={gw} /></section>
      <PlaybackBar gw={gw} />
      <section className="drawer" aria-label="Detail drawer">
        <div className="drawer-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={open && tab === id} className={`tab ${open && tab === id ? "on" : ""}`} onClick={() => { setTab(id); setOpen(true); }}>{label}</button>
          ))}
          <button type="button" className="tab collapse" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide ▾" : "Show ▴"}</button>
        </div>
        {open && (
          <div className="drawer-body">
            {tab === "agents" && (
              <>
                <div className="panel-head"><AgentsHeader gw={gw} /><RunControls gw={gw} /></div>
                <AgentGrid agents={gw.state!.agents} exp={exp} />
                <div className="panel-head"><div className="panel-head-left"><h3 className="label">Parallel timeline</h3><TimelineLegend /></div><TimelineTotals exp={exp} /></div>
                <Timeline exp={exp} />
              </>
            )}
            {tab === "rounds" && (
              <div className="vs-rounds">
                <div><h3 className="label">Champion score by round</h3><ImprovementChart exp={exp} /><DevBaselines exp={exp} /></div>
                <div><h3 className="label">Selection rule</h3><SelectionRule /><h3 className="label">Champion lineage</h3><Lineage exp={exp} selected={gw.resolvedRight ?? ""} onSelect={gw.setRightId} /></div>
              </div>
            )}
            {tab === "proof" && (
              <>
                <div className="panel-head-left"><span className="suite-tag held">HELD-OUT</span><span className="muted">champion frozen first · {exp.suiteSpecs.heldOut.count} unseen episodes</span></div>
                <HeldOutTables exp={exp} />
                {!exp.heldOut && <RunControls gw={gw} />}
              </>
            )}
            {tab === "log" && (
              <div className="more-grid">
                <Leaderboard exp={exp} onReplay={(id) => gw.setRightId(id)} />
                <ActivityLog items={gw.state?.activity ?? []} />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* ================= D · Lab notebook ================= */

function CandidateCard({ c }: { c: CandidateRecord }) {
  const verdict =
    c.status === "accepted" ? "Accepted · new champion" : c.status === "rejected" ? `Failed dev rule: ${c.decision[0] ?? ""}` : c.status === "screened-out" ? "Did not beat champion on training" : c.status === "invalid" ? "Invalid policy" : c.decision[0] ?? c.status;
  return (
    <article className={`nb-cand ${c.status}`} style={{ borderLeftColor: roleVar(c.role) }}>
      <div className="nb-cand-top">
        <span className="nb-role" style={{ color: roleVar(c.role) }}>{c.roleLabel}</span>
        <span className="mono muted small">{c.id}</span>
      </div>
      <div className="nb-name">{c.name}</div>
      {c.hypothesis && <p className="nb-hyp">{c.hypothesis}</p>}
      <div className="nb-meta mono">
        {c.train ? `train ${c.train.aggregate.score.toFixed(2)} (${fmt.pct(c.trainVsChampionPct)})` : "not simulated"}
        {c.dev ? ` · dev ${c.dev.aggregate.score.toFixed(2)}` : ""}
        {c.repairAttempts ? ` · ${c.repairAttempts} repair` : ""}
      </div>
      <div className={`nb-verdict ${c.status}`}>{verdict}</div>
    </article>
  );
}

function RoundLog({ exp }: { exp: Experiment }) {
  const rounds = exp.rounds.filter((r) => r.finishedAt);
  if (!rounds.length) return <p className="note">No rounds yet. Run improvement rounds to start the log.</p>;
  return (
    <div className="nb-log">
      {rounds.map((r) => {
        const cands = exp.candidates.filter((c) => c.round === r.round);
        const champ = exp.championHistory.find((h) => h.round === r.round);
        const parent = champ ? exp.championHistory[exp.championHistory.indexOf(champ) - 1] : undefined;
        const secs = (Date.parse(r.finishedAt!) - Date.parse(r.startedAt)) / 1000;
        return (
          <section key={r.round} className="nb-entry" aria-label={`Round ${r.round}`}>
            <header className="nb-entry-head">
              <h2>Round {r.round}</h2>
              <span className="mono muted small">{r.startedAt.slice(11, 19)} UTC · {Math.round(secs)} s · {cands.length} proposals in parallel</span>
            </header>
            <div className="nb-cands">{cands.map((c) => <CandidateCard key={c.id} c={c} />)}</div>
            <div className={`nb-outcome ${champ ? "new" : ""}`}>
              {champ ? (
                <>New champion <b>{champ.label}</b> · dev {champ.devScore.toFixed(2)} s{parent ? <> · built on <b>{parent.label}</b> ({parent.devScore.toFixed(2)} s)</> : null}</>
              ) : (
                <>Champion retained</>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function NotebookLayout({ gw }: { gw: GW }) {
  const exp = gw.exp!;
  return (
    <div className="app notebook">
      <header className="top">
        <div className="top-left"><h1>GreenWave State College</h1><Badges gw={gw} /></div>
        <UtilityButtons gw={gw} />
      </header>
      <Notices gw={gw} />
      <div className="nb-cols">
        <div className="nb-main">
          <section className="nb-card" aria-labelledby="nb-protocol">
            <h2 id="nb-protocol">Protocol</h2>
            <p>{exp.scoreDefinition}</p>
            <ul className="nb-facts mono">
              <li>Training {exp.suites.train.length} episodes · development {exp.suites.dev.length} · held-out {exp.suiteSpecs.heldOut.count} (generated only after freezing)</li>
              <li>Baselines on development: fixed-time {exp.baselines.fixed.dev.aggregate.score.toFixed(2)} · heuristic {exp.baselines.heuristic.dev.aggregate.score.toFixed(2)}</li>
              <li>Agents: {gw.provider?.label ?? ""} · {gw.state?.agents.length ?? 0} in parallel per round</li>
            </ul>
          </section>
          <section className="nb-card" aria-labelledby="nb-rule">
            <h2 id="nb-rule">Acceptance rule</h2>
            <SelectionRule />
            <RunControls gw={gw} />
          </section>
          <section className="nb-card" aria-label="Agents now"><div className="panel-head"><AgentsHeader gw={gw} /></div><AgentGrid agents={gw.state!.agents} exp={exp} /></section>
          <RoundLog exp={exp} />
          <MoreDetails gw={gw} />
        </div>
        <aside className="nb-side">
          <section className="nb-card" aria-labelledby="nb-replay">
            <div className="panel-head"><h2 id="nb-replay">Replay</h2><ScenarioSelect gw={gw} label="" /></div>
            <div className="nb-maps"><Maps gw={gw} theme="d" /></div>
            <PlaybackBar gw={gw} compact />
          </section>
          <section className="nb-card" aria-labelledby="nb-chart">
            <h2 id="nb-chart">Champion score by round</h2>
            <ImprovementChart exp={exp} height={220} />
            <p className="note mono">Champion now {champDev(exp).toFixed(2)} s on development · <CountsLine exp={exp} /></p>
          </section>
          <section className="nb-card proof" aria-labelledby="nb-proof">
            <h2 id="nb-proof">Proof on unseen traffic</h2>
            <HeldOutTables exp={exp} />
          </section>
        </aside>
      </div>
    </div>
  );
}
