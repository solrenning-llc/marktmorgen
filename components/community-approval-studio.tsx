"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { HELD_DAYS, MAX_FIRST, MAX_HELD, MAX_WHY, TOLD_DAYS } from "@/lib/community-approval-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** One post or comment waiting for approval, as the studio shows it. */
export type HeldRow = {
  id: string;
  kind: "post" | "comment";
  author: string;
  authorEmail: string;
  at: number;
  daysLeft: number;
  space: string;
  title: string;
  text: string;
  picture: boolean;
  poll: boolean;
  /** For a comment, the post it answers. */
  href: string;
};

type Mode = "off" | "first" | "all";
export type SpaceRule = { id: string; name: string; posts: { mode: Mode; n: number }; comments: { mode: Mode; n: number } };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  not_set_up: "Set the community up first.",
  unknown: "That space is not there anymore. Reload the page.",
  approval_rule: `Pick how many first posts to approve, from 1 to ${MAX_FIRST}.`,
  gone: "That one is not waiting anymore. Reload the page.",
  held_full: "It could not be published: the community, or that post's comments, are full. Make room, then try again.",
  held_post_gone: "The post it answered was deleted, so it was not published. Its author sees that in the community.",
  store_full: "Your store has reached the most it can hold. Remove something first.",
  unknown_reply: "We could not confirm that, so nothing was published. Try again in a moment.",
  signed_out: "Your session ended. Log in again.",
  invalid: "That could not be read. Nothing was changed.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { ok?: boolean; error?: string };

async function send(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/community/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const small =
  "inline-flex min-h-11 min-w-11 items-center text-sm font-semibold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

/**
 * 543 [CM2] in the studio: which spaces hold posts or comments for approval,
 * and the queue of what waits, beside the reports. Approving publishes;
 * "Don't publish" tells the author, with an optional sentence.
 */
export function CommunityApprovalStudio({
  rules,
  queue,
  canSettings,
}: {
  /** Each space's rule; null when they could not be read. */
  rules: SpaceRule[] | null;
  /** What waits, oldest first; null when it could not be read. */
  queue: HeldRow[] | null;
  canSettings: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ where: string; text: string } | null>(null);

  async function run(where: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(where);
    setError(null);
    const answer = await send(payload);
    setBusy(null);
    if (!answer.ok) {
      setError({ where, text: MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error });
      return false;
    }
    toast(done);
    router.refresh();
    return true;
  }
  const problem = (where: string) =>
    error?.where === where ? (
      <p className="notice notice-error mt-3" role="alert">
        {error.text}
      </p>
    ) : null;

  return (
    <>
      {canSettings ? <Rules rules={rules} busy={busy} run={run} problem={problem} /> : null}
      <Waiting queue={queue} busy={busy} run={run} problem={problem} />
    </>
  );
}

type Runner = (where: string, payload: Record<string, unknown>, done: string) => Promise<boolean>;
type Problem = (where: string) => React.ReactNode;

function Waiting({ queue, busy, run, problem }: { queue: HeldRow[] | null; busy: string | null; run: Runner; problem: Problem }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="cm-held-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cm-held-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Waiting for approval</h2>
        <span className={`tag ${queue?.length ? "tag-brand" : ""}`}>{queue === null ? "Not loaded" : queue.length ? `${queue.length} to approve` : "None to approve"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        {`Posts and comments held by a space's approval setting. Only their authors and you can see them. Approve to publish one. If you don't publish one, its author is told, with your note if you write one. After ${HELD_DAYS} days without an answer, it is not published, and its author is told. Up to ${MAX_HELD} can wait at once.`}
      </p>
      {queue === null ? (
        <p role="status" className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
          What is waiting could not be loaded, so nothing is shown as approved or not. Reload this page to check.
        </p>
      ) : queue.length === 0 ? (
        <p className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">None to approve. When a space holds a post or a comment for you, it shows up here.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {queue.map((row) => (
            <li key={row.id} className="rounded-[var(--r-md)] border border-line p-4">
              <p className="text-sm text-ink-soft">
                <span className="font-semibold text-ink">{row.kind === "post" ? "Post" : "Comment"}</span>
                {` by ${row.author}`}
                {row.authorEmail ? <span className="break-all">{` (${row.authorEmail})`}</span> : null}
                {` · in ${row.space} · sent ${day(row.at)} · ${row.daysLeft === 1 ? "1 day" : `${row.daysLeft} days`} left`}
              </p>
              {row.title ? <p className="mt-2 font-semibold break-words text-ink">{row.title}</p> : null}
              <p className="mt-1 whitespace-pre-line break-words text-ink">{row.text || (row.picture ? "(a picture)" : "")}</p>
              {row.picture || row.poll ? (
                <p className="mt-1 text-sm text-ink-soft">{[row.picture ? "It has a picture." : "", row.poll ? "It is a poll." : ""].filter(Boolean).join(" ")}</p>
              ) : null}
              {removing === row.id ? (
                <form
                  className="mt-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await run(`h-${row.id}`, { action: "remove", item: row.id, why }, "Not published. Its author sees that in the community, with your note.")) {
                      setRemoving(null);
                      setWhy("");
                    }
                  }}
                >
                  <label htmlFor={`cm-why-${row.id}`} className="field-label">A note for its author (optional)</label>
                  <input
                    id={`cm-why-${row.id}`}
                    className="field mt-1"
                    value={why}
                    maxLength={MAX_WHY}
                    onChange={(event) => setWhy(event.target.value)}
                    aria-describedby={`cm-why-help-${row.id}`}
                    autoComplete="off"
                  />
                  <p id={`cm-why-help-${row.id}`} className="mt-1 text-sm text-ink-soft">Only its author sees it. It is not published, and it stays in their own view for up to {TOLD_DAYS} days.</p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button type="submit" className="btn btn-secondary" disabled={busy !== null} aria-busy={busy === `h-${row.id}`}>
                      Don&apos;t publish it
                    </button>
                    <button type="button" className={small} disabled={busy !== null} onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button type="button" className="btn btn-primary" disabled={busy !== null} aria-busy={busy === `h-${row.id}`} onClick={() => run(`h-${row.id}`, { action: "approve", item: row.id }, "Approved and published.")}>
                    Approve
                  </button>
                  <button
                    type="button"
                    className={small}
                    disabled={busy !== null}
                    onClick={() => {
                      setRemoving(row.id);
                      setWhy("");
                    }}
                  >
                    Don&apos;t publish
                  </button>
                  {row.href ? (
                    <a href={row.href} className={small}>
                      See the post it answers
                    </a>
                  ) : null}
                </div>
              )}
              {problem(`h-${row.id}`)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MODES: { value: Mode; label: string }[] = [
  { value: "off", label: "Publish right away" },
  { value: "first", label: "Approve the first ones of new members" },
  { value: "all", label: "Approve every one" },
];

function Rules({ rules, busy, run, problem }: { rules: SpaceRule[] | null; busy: string | null; run: Runner; problem: Problem }) {
  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="cm-approval-title">
      <h2 id="cm-approval-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Approval before publishing</h2>
      <p className="mt-2 text-ink-soft">
        For each space, choose whether members&apos; posts and comments publish right away, or wait for you first. &quot;New members&quot; are those who join after you choose it. You are never held.
      </p>
      {rules === null ? (
        <p role="status" className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
          The approval settings could not be loaded. Reload this page to see and change them.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {rules.map((rule) => (
            <SpaceRuleForm key={rule.id} rule={rule} busy={busy} run={run} problem={problem} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SpaceRuleForm({ rule, busy, run, problem }: { rule: SpaceRule; busy: string | null; run: Runner; problem: Problem }) {
  const [posts, setPosts] = useState(rule.posts);
  const [comments, setComments] = useState(rule.comments);
  const changed = JSON.stringify(posts) !== JSON.stringify(rule.posts) || JSON.stringify(comments) !== JSON.stringify(rule.comments);
  const where = `r-${rule.id}`;
  const pick = (what: "posts" | "comments", value: { mode: Mode; n: number }, set: (v: { mode: Mode; n: number }) => void) => {
    const id = `cm-ap-${what}-${rule.id}`;
    return (
      <div>
        <label htmlFor={id} className="field-label">{what === "posts" ? "Posts" : "Comments"}</label>
        <select id={id} className="field mt-1" value={value.mode} onChange={(event) => set({ mode: event.target.value as Mode, n: value.n >= 1 ? value.n : 1 })}>
          {MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        {value.mode === "first" ? (
          <>
            <label htmlFor={`${id}-n`} className="field-label mt-2 block">How many of each new member&apos;s first {what}</label>
            <select id={`${id}-n`} className="field mt-1" value={value.n} onChange={(event) => set({ mode: "first", n: Number(event.target.value) })}>
              {Array.from({ length: MAX_FIRST }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
    );
  };
  return (
    <li className="rounded-[var(--r-md)] border border-line p-4">
      <fieldset>
        <legend className="font-semibold text-ink">{rule.name}</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {pick("posts", posts, setPosts)}
          {pick("comments", comments, setComments)}
        </div>
      </fieldset>
      <button
        type="button"
        className="btn btn-secondary mt-3"
        disabled={busy !== null || !changed}
        aria-busy={busy === where}
        onClick={() => run(where, { action: "setting", space: rule.id, posts, comments }, `Saved for ${rule.name}.`)}
      >
        Save
      </button>
      {problem(where)}
    </li>
  );
}
