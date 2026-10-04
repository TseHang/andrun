// Auto mode (ADR D19, amended): a small model sorts each turn, and the turn runs on the model and
// effort configured for that kind. Routing is done here, on our side; ai& has no routing API yet.

import { autoConfig } from "./config";
import type { ModelRoute, TaskKind } from "./config";
import type { ModelClient } from "./types";

/** Also how the fake model server recognises a classifier request. */
export const CLASSIFIER_SYSTEM_PROMPT = `You sort requests made to a coding agent. Reply with one word, "daily" or "complex", and nothing else.

daily: everyday coding. A small or well-scoped change, a bug fix in a known place, a question, a rename, a test, a simple page.
complex: needs deep thinking or a long run. A change across many files, a new feature with design choices, a refactor, an unclear bug, a performance or concurrency problem, an architecture question.`;

const MAX_TASK_CHARS = 4000;

/** Sorts the turn that `task` starts. Any failure or unclear answer falls back to "daily": routing must never fail a run. */
export async function classifyTask(model: ModelClient, task: string, signal?: AbortSignal): Promise<TaskKind> {
  try {
    const res = await model.complete({
      ...autoConfig.classifier,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: task.slice(0, MAX_TASK_CHARS) },
      ],
      tools: [],
      ...(signal && { signal }),
    });
    return /^\W*complex\b/i.test(res.content ?? "") ? "complex" : "daily";
  } catch {
    return "daily";
  }
}

export const routeFor = (task: TaskKind): ModelRoute => autoConfig.routes[task];
