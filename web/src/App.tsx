import { useEffect, useState } from "react";
import { NotebookLayout, OpsLayout, StoryLayout, VersusLayout } from "./layouts";
import { useGreenwave } from "./useGreenwave";

const LAYOUTS = [
  { id: "a", label: "A · Ops command center" },
  { id: "b", label: "B · Story mode" },
  { id: "c", label: "C · Split-screen versus" },
  { id: "d", label: "D · Lab notebook" },
] as const;
type LayoutId = (typeof LAYOUTS)[number]["id"];

function initialLayout(): LayoutId {
  const fromHash = window.location.hash.replace("#", "");
  if (LAYOUTS.some((l) => l.id === fromHash)) return fromHash as LayoutId;
  try {
    const saved = localStorage.getItem("gw-layout");
    if (saved && LAYOUTS.some((l) => l.id === saved)) return saved as LayoutId;
  } catch {
    // storage unavailable
  }
  return "a";
}

export function App() {
  const gw = useGreenwave();
  const [layout, setLayout] = useState<LayoutId>(initialLayout);

  useEffect(() => {
    document.documentElement.dataset.theme = layout;
    try {
      localStorage.setItem("gw-layout", layout);
    } catch {
      // storage unavailable
    }
    if (window.location.hash !== `#${layout}`) history.replaceState(null, "", `#${layout}`);
  }, [layout]);

  return (
    <div className="shell" data-theme={layout}>
      <nav className="switcher" aria-label="Layout">
        <span className="switcher-label">Layout</span>
        {LAYOUTS.map((l) => (
          <button key={l.id} type="button" aria-pressed={layout === l.id} className={layout === l.id ? "on" : ""} onClick={() => setLayout(l.id)}>
            {l.label}
          </button>
        ))}
      </nav>
      {!gw.exp ? (
        <div className="empty-state">{gw.busy ?? "Connecting to server…"}</div>
      ) : layout === "a" ? (
        <OpsLayout gw={gw} />
      ) : layout === "b" ? (
        <StoryLayout gw={gw} />
      ) : layout === "c" ? (
        <VersusLayout gw={gw} />
      ) : (
        <NotebookLayout gw={gw} />
      )}
    </div>
  );
}
