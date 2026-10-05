import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Status } from "../../src/core/events";
import type { SessionSummary } from "../../src/session/protocol";
import { getConfig, listPulls, listSessions, type Config, type PullRow } from "./api";
import { Home } from "./components/Home";
import { SessionPage } from "./components/SessionPage";
import { PullRequestsPage } from "./components/PullRequestsPage";
import { ReviewStartPage } from "./components/ReviewStartPage";
import { Sidebar } from "./components/Sidebar";
import { App_, type AppContext } from "./context";
import { usePanelHidden } from "./state/hidden";

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [path, setPath] = useState(location.pathname);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [stale, setStale] = useState(false);
  const [pulls, setPulls] = useState<{ pulls: PullRow[] | null; error: string | null }>({ pulls: null, error: null });
  const [live, setLive] = useState<{ id: string; status: Status } | null>(null);
  const [sidebarHidden, setSidebarHidden] = usePanelHidden("andrun.sidebar.hidden");
  const [instant, setInstant] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  // ⌘\ (Ctrl+\ elsewhere) shows or hides the sidebar. A key press is instant: no slide on a shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setInstant(true);
      setSidebarHidden(!sidebarHidden);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarHidden, setSidebarHidden]);

  useEffect(() => {
    void getConfig().then(setConfig, () => undefined);
  }, []);

  const navigate = useCallback((to: string) => {
    history.pushState(null, "", to);
    setPath(location.pathname);
  }, []);

  // Hand-written router: back/forward, and same-origin link clicks.
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest("a");
      if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
      if (a.pathname !== "/" && !/^\/(s\/[^/]+|prs(\/\d+)?)\/?$/.test(a.pathname)) return;
      e.preventDefault();
      if (a.pathname + a.search !== location.pathname + location.search) navigate(a.pathname + a.search);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [navigate]);

  // A response older than one already applied is dropped, so overlapping requests cannot undo a newer list.
  const asked = useRef(0);
  const applied = useRef(0);
  const refreshList = useCallback(() => {
    const n = ++asked.current;
    listSessions().then(
      (rows) => {
        if (n < applied.current) return;
        applied.current = n;
        setSessions(rows);
        setStale(false);
      },
      () => n >= applied.current && setStale(true),
    );
  }, []);

  // Refresh on load, on focus, and every 5 s while the tab is visible.
  useEffect(() => {
    refreshList();
    const tick = setInterval(() => document.visibilityState === "visible" && refreshList(), 5000);
    window.addEventListener("focus", refreshList);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", refreshList);
    };
  }, [refreshList]);

  // Same rule for the pull list, which comes from GitHub: the sidebar count and the page share it.
  const askedPulls = useRef(0);
  const appliedPulls = useRef(0);
  const refreshPulls = useCallback(() => {
    const n = ++askedPulls.current;
    listPulls().then(
      (rows) => {
        if (n < appliedPulls.current) return;
        appliedPulls.current = n;
        setPulls({ pulls: rows, error: null });
      },
      (e: Error) => {
        if (n < appliedPulls.current) return;
        appliedPulls.current = n;
        setPulls({ pulls: null, error: e.message });
      },
    );
  }, []);

  useEffect(() => {
    refreshPulls();
    window.addEventListener("focus", refreshPulls);
    return () => window.removeEventListener("focus", refreshPulls);
  }, [refreshPulls]);

  const onPrs = /^\/prs\/?$/.test(path);
  useEffect(() => {
    if (onPrs) refreshPulls();
  }, [onPrs, refreshPulls]);

  const reportStatus = useCallback((id: string, status: Status | null) => setLive(status ? { id, status } : null), []);

  const ctx = useMemo<AppContext | null>(() => (config ? { config, navigate, refreshList, refreshPulls, reportStatus } : null), [config, navigate, refreshList, refreshPulls, reportStatus]);
  if (!ctx) return null;

  const sessionId = /^\/s\/([^/]+)\/?$/.exec(path)?.[1];
  const reviewNumber = /^\/prs\/([^/]+)\/?$/.exec(path)?.[1];
  return (
    <App_.Provider value={ctx}>
      <div className="flex h-screen min-w-[1024px] overflow-hidden bg-white">
        <Sidebar
          sessions={sessions}
          stale={stale}
          path={path}
          live={live}
          pullCount={pulls.pulls?.length ?? null}
          collapsed={sidebarHidden}
          instant={instant}
          onToggle={() => {
            setInstant(false);
            setSidebarHidden(!sidebarHidden);
            slideContent(content.current, sidebarHidden ? -SIDEBAR_TRAVEL : SIDEBAR_TRAVEL);
          }}
        />
        <div ref={content} className="flex min-w-0 grow">
          {sessionId ? (
            <SessionPage id={sessionId} />
          ) : onPrs ? (
            <PullRequestsPage pulls={pulls.pulls} error={pulls.error} />
          ) : reviewNumber ? (
            <ReviewStartPage number={Number(reviewNumber)} />
          ) : (
            <Home />
          )}
        </div>
      </div>
    </App_.Provider>
  );
}

/** How far the sidebar's edge moves: 248 px open, 52 px as a rail. */
const SIDEBAR_TRAVEL = 248 - 52;

/**
 * The page takes its new width at once (one reflow, not one per frame) and slides from where the sidebar's edge was,
 * with the sidebar's duration and curve, so the two move together. Skipped for reduced motion.
 */
function slideContent(el: HTMLElement | null, from: number): void {
  if (!el?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ transform: `translateX(${from}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
}
