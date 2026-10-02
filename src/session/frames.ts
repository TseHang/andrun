// Validation of frames received from the browser (P2-b). Platform-free.

import { MAX_TASK_CHARS, TITLE_CHARS, type ParsedFrame } from "./protocol";

const bad = (reason: string): ParsedFrame => ({ ok: false, reason });
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseClientFrame(raw: string | ArrayBuffer): ParsedFrame {
  if (typeof raw !== "string") return bad("binary frames are not supported");
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("frame is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("frame must be a JSON object");
  const f = v as Record<string, unknown>;
  switch (f.type) {
    case "approve":
      if (!nonEmpty(f.approvalId)) return bad("approve needs an approvalId");
      return { ok: true, frame: { type: "approve", approvalId: f.approvalId } };
    case "reject":
      if (!nonEmpty(f.approvalId)) return bad("reject needs an approvalId");
      if (typeof f.comment !== "string" || f.comment.trim() === "") return bad("reject needs a comment");
      return { ok: true, frame: { type: "reject", approvalId: f.approvalId, comment: f.comment } };
    case "message":
      if (typeof f.text !== "string" || f.text.trim() === "") return bad("message needs text");
      if (f.text.length > MAX_TASK_CHARS) return bad(`message is longer than ${MAX_TASK_CHARS} characters`);
      return { ok: true, frame: { type: "message", text: f.text } };
    default:
      return bad("unknown frame type");
  }
}

export function titleOf(task: string): string {
  return task.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
}
