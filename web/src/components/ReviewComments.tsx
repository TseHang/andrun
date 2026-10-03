import { useCallback, useEffect, useState } from "react";
import type { ClientFrame } from "../../../src/session/protocol";
import { listComments, replyToComment, type ReviewThread } from "../api";
import { useApp } from "../context";
import { relativeTime } from "../state/format";

const BUTTON = "h-8 shrink-0 cursor-pointer rounded-full bg-black/6 px-3.5 text-[13px] font-semibold text-text disabled:cursor-default disabled:bg-black/4 disabled:text-text-tertiary";

function age(createdAt: string): string {
  const t = relativeTime(Date.parse(createdAt), Date.now());
  return t === "now" ? "just now" : `${t} ago`;
}

function Thread({ pr, thread, owner, running, send, onReplied }: { pr: number; thread: ReviewThread; owner: string; running: boolean; send: (f: ClientFrame) => boolean; onReplied: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reply = async () => {
    setSending(true);
    setError(null);
    const res = await replyToComment(pr, thread.id, text.trim());
    setSending(false);
    if (!res.ok) return setError(res.error);
    setText("");
    onReplied();
  };

  const ask = () => {
    const reply = text.trim();
    const message = `Fix this review comment on pull request #${pr}.\n\n${thread.path}:${thread.line}\n${thread.author}: ${thread.body}${reply ? `\n\nReply from ${owner}: ${reply}` : ""}`;
    send({ type: "message", text: message });
  };

  return (
    <div data-comment={thread.id} className="flex flex-col gap-2 rounded-xl bg-sidebar p-3.5">
      <div className="flex items-baseline gap-2 text-xs text-text-secondary">
        <span className="font-semibold text-text">{thread.author}</span>
        <span className="font-mono">{`${thread.path}:${thread.line}`}</span>
        <span className="grow">{age(thread.createdAt)}</span>
        {thread.answered && <span className="rounded-full bg-fill px-2 py-0.5 font-semibold">Answered</span>}
      </div>
      <p className="m-0 text-[14px] break-words whitespace-pre-wrap">{thread.body}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="ml-5 flex flex-col gap-0.5 border-l border-black/10 pl-3">
          <span className="text-xs font-semibold">{r.author}</span>
          <p className="m-0 text-[14px] break-words whitespace-pre-wrap">{r.body}</p>
        </div>
      ))}
      <textarea
        aria-label="Reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full resize-y rounded-[10px] bg-white px-3 py-2 text-[14px] shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"
      />
      <div className="flex items-center gap-2">
        <button type="button" disabled={!text.trim() || sending} onClick={() => void reply()} className={BUTTON}>
          Reply
        </button>
        <button type="button" disabled={running} onClick={ask} className={BUTTON}>
          Ask the agent to fix
        </button>
        <span className="text-xs text-text-tertiary">Posts as {owner}</span>
      </div>
      {error && (
        <div role="alert" className="text-xs text-failed">
          {error}
        </div>
      )}
    </div>
  );
}

/** The review comments of the pull request this Code session opened: read, reply, or ask the agent to fix one. */
export function ReviewComments({ pr, prCards, running, send }: { pr: number; prCards: number; running: boolean; send: (f: ClientFrame) => boolean }) {
  const { config } = useApp();
  const owner = config.repo.split("/")[0]!;
  const [threads, setThreads] = useState<ReviewThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listComments(pr).then(
      (t) => {
        setThreads(t);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Could not load the review comments."),
    );
  }, [pr]);

  // On opening, and when a pull request card is added (the pull request may be new).
  useEffect(load, [load, prCards]);

  const open = (threads ?? []).filter((t) => !t.answered).length;
  return (
    <section aria-label="Review comments" className="my-6 flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-semibold">Review comments</h2>
        {threads && <span className="text-xs text-text-secondary">{open} open</span>}
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg bg-danger-bg px-3 py-2 text-danger-text">
          <span className="grow">{error}</span>
          <button type="button" onClick={load} className="shrink-0 cursor-pointer rounded-full bg-white px-3.5 py-1 font-semibold">
            Retry
          </button>
        </div>
      )}
      {threads?.length === 0 && <p className="m-0 text-xs text-text-secondary">No review comments yet.</p>}
      {threads?.map((t) => (
        <Thread key={t.id} pr={pr} thread={t} owner={owner} running={running} send={send} onReplied={load} />
      ))}
      <p className="m-0 text-xs text-text-secondary">The &run bot opened this pull request. Replies are posted as {owner}. Ask the agent to fix starts another round in this session.</p>
    </section>
  );
}
