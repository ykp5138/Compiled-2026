// Playback clock kept outside React state so advancing time re-renders only the components that read it
// (maps, live metrics, scrubber, scoreboard), not the whole page.
import { useSyncExternalStore } from "react";

let t = 0;
const listeners = new Set<() => void>();

export const clock = {
  get: () => t,
  set: (v: number) => {
    if (v === t) return;
    t = v;
    for (const l of listeners) l();
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useClock(): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}
