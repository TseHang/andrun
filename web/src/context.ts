import { createContext, useContext } from "react";
import type { Status } from "../../src/core/events";
import type { Config } from "./api";

export interface AppContext {
  config: Config;
  navigate: (to: string) => void;
  refreshList: () => void;
  refreshPulls: () => void;
  /** The open session reports its live status so its sidebar row follows it. */
  reportStatus: (id: string, status: Status | null) => void;
}

export const App_ = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(App_);
  if (!ctx) throw new Error("no app context");
  return ctx;
}
