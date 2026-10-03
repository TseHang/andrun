import { useCallback, useEffect, useMemo, useState } from "react";
import type { Status } from "../../src/core/events";
import type { SessionSummary } from "../../src/session/protocol";
import { getConfig, listSessions, type Config } from "./api";
import { Home } from "./components/Home";
import { SessionPage } from "./components/SessionPage";
import { Sidebar } from "./components/Sidebar";
import { App_, type AppContext } from "./context";

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [path, setPath] = useState(location.pathname);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [stale, setStale] = useState(false);
  const [live, setLive] = useState<{ id: string; status: Status } | null>(null);

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

  const refreshList = useCallback(() => {
    listSessions().then(
      (rows) => {
        setSessions(rows);
        setStale(false);
      },
      () => setStale(true),
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

  const reportStatus = useCallback((id: string, status: Status | null) => setLive(status ? { id, status } : null), []);

  const ctx = useMemo<AppContext | null>(() => (config ? { config, navigate, refreshList, reportStatus } : null), [config, navigate, refreshList, reportStatus]);
  if (!ctx) return null;

  const sessionId = /^\/s\/([^/]+)\/?$/.exec(path)?.[1];
  return (
    <App_.Provider value={ctx}>
      <div className="flex h-screen min-w-[1024px] overflow-hidden bg-white">
        <Sidebar sessions={sessions} stale={stale} path={path} live={live} />
        {sessionId ? <SessionPage id={sessionId} /> : <Home sessions={sessions} />}
      </div>
    </App_.Provider>
  );
}
