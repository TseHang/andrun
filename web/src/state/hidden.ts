import { useState } from "react";

// Whether a side panel is hidden: remembered in localStorage under `key`, shown if that is unavailable.
// The third value says the user brought the panel back during this visit, so it may slide in (it never does on load).
export function usePanelHidden(key: string): [boolean, (hidden: boolean) => void, boolean] {
  const [hidden, setHidden] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const [reopened, setReopened] = useState(false);
  const set = (next: boolean) => {
    setHidden(next);
    if (!next && hidden) setReopened(true);
    try {
      if (next) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch {
      // Not remembered, but the toggle still works for this visit.
    }
  };
  return [hidden, set, reopened];
}
