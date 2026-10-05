// Validation of frames received from the browser (P2-b). Platform-free.

import { MAX_FINDING_CHARS, MAX_PR_SUMMARY_CHARS, MAX_PR_TITLE_CHARS, MAX_REVIEW_COMMENT_CHARS, MAX_TASK_CHARS, TITLE_CHARS, type ParsedFrame } from "./protocol";

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
    case "approve": {
      if (!nonEmpty(f.approvalId)) return bad("approve needs an approvalId");
      if (f.title !== undefined && typeof f.title !== "string") return bad("title must be text");
      if (f.summary !== undefined && typeof f.summary !== "string") return bad("summary must be text");
      const title = f.title?.replace(/\s+/g, " ").trim() ?? "";
      const summary = f.summary?.trim() ?? "";
      if (title.length > MAX_PR_TITLE_CHARS) return bad(`title is longer than ${MAX_PR_TITLE_CHARS} characters`);
      if (summary.length > MAX_PR_SUMMARY_CHARS) return bad(`summary is longer than ${MAX_PR_SUMMARY_CHARS} characters`);
      return { ok: true, frame: { type: "approve", approvalId: f.approvalId, ...(title && { title }), ...(f.summary !== undefined && { summary }) } };
    }
    case "reject":
      if (!nonEmpty(f.approvalId)) return bad("reject needs an approvalId");
      if (typeof f.comment !== "string" || f.comment.trim() === "") return bad("reject needs a comment");
      return { ok: true, frame: { type: "reject", approvalId: f.approvalId, comment: f.comment } };
    case "message":
      if (typeof f.text !== "string" || f.text.trim() === "") return bad("message needs text");
      if (f.text.length > MAX_TASK_CHARS) return bad(`message is longer than ${MAX_TASK_CHARS} characters`);
      return { ok: true, frame: { type: "message", text: f.text } };
    case "stop":
      return { ok: true, frame: { type: "stop" } };
    case "finding": {
      if (!nonEmpty(f.id)) return bad("finding needs an id");
      if (f.text === undefined && f.dismissed === undefined) return bad("finding needs text or dismissed");
      if (f.dismissed !== undefined && typeof f.dismissed !== "boolean") return bad("dismissed must be true or false");
      let text: string | undefined;
      if (f.text !== undefined) {
        text = typeof f.text === "string" ? f.text.trim() : "";
        if (text === "") return bad("finding text must not be empty");
        if (text.length > MAX_FINDING_CHARS) return bad(`finding text is longer than ${MAX_FINDING_CHARS} characters`);
      }
      return { ok: true, frame: { type: "finding", id: f.id, ...(text !== undefined && { text }), ...(f.dismissed !== undefined && { dismissed: f.dismissed }) } };
    }
    case "post_review": {
      if (!nonEmpty(f.approvalId)) return bad("post_review needs an approvalId");
      if (f.verdict !== "COMMENT" && f.verdict !== "APPROVE" && f.verdict !== "REQUEST_CHANGES") return bad("verdict must be COMMENT, APPROVE or REQUEST_CHANGES");
      if (f.comment !== undefined && typeof f.comment !== "string") return bad("comment must be text");
      const comment = f.comment?.trim() ?? "";
      if (comment.length > MAX_REVIEW_COMMENT_CHARS) return bad(`comment is longer than ${MAX_REVIEW_COMMENT_CHARS} characters`);
      return { ok: true, frame: { type: "post_review", approvalId: f.approvalId, verdict: f.verdict, ...(comment && { comment }) } };
    }
    default:
      return bad("unknown frame type");
  }
}

export function titleOf(task: string): string {
  return task.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
}
