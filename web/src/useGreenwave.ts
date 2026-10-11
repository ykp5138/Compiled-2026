import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribe, type PublicState, type Replay } from "./api";

export interface ControllerOption {
  id: string;
  label: string;
}

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

export function useGreenwave() {
  const [state, setState] = useState<PublicState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);
  const [leftId, setLeftId] = useState("baseline-fixed");
  const [rightId, setRightId] = useState("champion");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [heat, setHeat] = useState(false);
  const [rounds, setRounds] = useState(6);
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
  const mismatch = !!(
    left.replay &&
    right.replay &&
    (left.replay.scenarioId !== right.replay.scenarioId || left.replay.scenarioChecksum !== right.replay.scenarioChecksum)
  );
  const ready = !!(left.replay && right.replay && !mismatch && left.replay.scenarioId === scenario && right.replay.scenarioId === scenario);
  const duration = left.replay ? left.replay.horizon + left.replay.drain : 1200;

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

  useEffect(() => setT(0), [scenario]);

  const leftOptions: ControllerOption[] = exp
    ? [
        { id: "baseline-fixed", label: exp.baselines.fixed.label },
        { id: "baseline-heuristic", label: exp.baselines.heuristic.label },
      ]
    : [];
  const rightOptions: ControllerOption[] = useMemo(() => {
    if (!exp) return [];
    const champLabel = exp.championHistory[exp.championHistory.length - 1]?.label ?? exp.championId;
    const opts: ControllerOption[] = [{ id: "champion", label: `★ ${champLabel}` }];
    for (const h of exp.championHistory) opts.push({ id: h.policyId, label: `Champion after ${h.round === 0 ? "start" : `R${h.round}`} · ${h.label}` });
    for (const c of exp.candidates) if (c.policy) opts.push({ id: c.id, label: `${c.id} · ${c.name} (${c.status})` });
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

  const togglePlay = () => {
    if (t >= duration) {
      setT(0);
      setPlaying(true);
    } else setPlaying(!playing);
  };

  return {
    state,
    exp,
    toast,
    setToast,
    scenarios,
    scenario,
    setScenario,
    leftId,
    setLeftId,
    rightId,
    setRightId,
    resolvedRight,
    left,
    right,
    mismatch,
    ready,
    duration,
    t,
    setT,
    playing,
    setPlaying,
    togglePlay,
    speed,
    setSpeed,
    heat,
    setHeat,
    rounds,
    setRounds,
    check,
    setCheck,
    act,
    busy: state?.busy ?? null,
    provider: state?.provider,
    recorded: !!(exp && !state?.live && exp.rounds.length > 0),
    leftOptions,
    rightOptions,
    runCheck: () =>
      act(async () => {
        const r = await api.check();
        setCheck(`${r.ok ? "✓" : "✗"} ${r.detail} (${r.latencyMs} ms)`);
      }),
  };
}

export type GW = ReturnType<typeof useGreenwave>;
