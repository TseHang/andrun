// Building and posting a pull request review (ADR D9). The review is posted with the user's PAT, so it
// is theirs; the footer says a human checked it.

import type { Request } from "./client";

export const REVIEW_FOOTER = "Drafted with &run, checked and posted by a human.";

export interface ReviewFinding {
  path: string;
  line: number;
  severity: "high" | "medium" | "low";
  text: string;
  inline: boolean;
  dismissed: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewInput {
  pr: number;
  commitId: string;
  verdict: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: ReviewComment[];
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `comment` is the reviewer's own text; it opens the body. */
export function buildReview(findings: ReviewFinding[], comment = ""): { body: string; comments: ReviewComment[] } {
  const kept = findings.filter((f) => !f.dismissed);
  const comments = kept.filter((f) => f.inline).map((f) => ({ path: f.path, line: f.line, body: `**${capitalise(f.severity)}:** ${f.text}` }));
  const notes = kept.filter((f) => !f.inline).map((f) => `- **${capitalise(f.severity)}** \`${f.path}:${f.line}\`: ${f.text}`);
  const parts = notes.length > 0 ? ["Notes that are not on a changed line:", notes.join("\n")] : [];
  return { body: [...(comment ? [comment] : []), ...parts, REVIEW_FOOTER].join("\n\n"), comments };
}

export async function postReview(request: Request, repo: string, pat: string, input: ReviewInput): Promise<{ url: string }> {
  const res = (await request("POST", `/repos/${repo}/pulls/${input.pr}/reviews`, pat, {
    commit_id: input.commitId,
    event: input.verdict,
    body: input.body,
    comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
  })) as { html_url: string };
  return { url: res.html_url };
}
