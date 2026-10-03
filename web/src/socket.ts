// useSession: the live socket of one session, folded into a SessionView (P3-k reconnect rules).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientFrame, ServerFrame } from "../../src/session/protocol";
import { getSnapshot } from "./api";
import { dropStreaming, initialView, reduce, type SessionView } from "./state/reducer";

export interface LiveSession {
  view: SessionView;
  send: (frame: ClientFrame) => boolean;
  reconnecting: boolean;
  deleted: boolean;
}

export function useSession(id: string): LiveSession {
  const [view, setView] = useState(initialView);
  const [reconnecting, setReconnecting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let delay = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = initialView();
    setView(current);
    setReconnecting(false);
    setDeleted(false);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/sessions/${id}/ws?lastSeq=${current.lastSeq}`);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 500;
        setReconnecting(false);
      };
      ws.onmessage = (e) => {
        try {
          current = reduce(current, JSON.parse(String(e.data)) as ServerFrame);
          setView(current);
        } catch {
          /* ignore a malformed frame */
        }
      };
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 1000 && e.reason === "session deleted") return setDeleted(true);
        setReconnecting(true);
        current = dropStreaming(current);
        setView(current);
        void getSnapshot(id)
          .then((s) => {
            if (stopped) return;
            if (s === null) return setDeleted(true);
            retry();
          })
          .catch(() => !stopped && retry());
      };
    };
    const retry = () => {
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [id]);

  const send = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  return { view, send, reconnecting, deleted };
}
