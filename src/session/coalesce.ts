// Merges bursts of command output into one event per window (ADR D7). Platform-free.

import type { AgentEvent } from "../core/events";

type OutputEvent = Extract<AgentEvent, { type: "tool_output" }>;

function isStreamChunk(event: AgentEvent): event is OutputEvent {
  return event.type === "tool_output" && (event.stream === "stdout" || event.stream === "stderr") && event.exitCode === undefined;
}

export class OutputCoalescer {
  private buffer: OutputEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: { windowMs: number; sink: (event: AgentEvent) => void }) {}

  push(event: AgentEvent): void {
    if (!isStreamChunk(event)) {
      this.flush();
      this.opts.sink(event);
      return;
    }
    const b = this.buffer;
    if (b && b.callId === event.callId && b.stream === event.stream) {
      // The merged event is the last part with all chunks joined, so its seq is the last part's.
      this.buffer = { ...event, chunk: b.chunk + event.chunk };
      return;
    }
    this.flush();
    this.buffer = event;
    this.timer = setTimeout(() => this.flush(), this.opts.windowMs);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const b = this.buffer;
    this.buffer = null;
    if (b) this.opts.sink(b);
  }
}
