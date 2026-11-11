"use client";

import { useHydrated } from "@/components/use-hydrated";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { InboxBlock } from "@/components/inbox-block";
import { FaqFromInbox } from "@/components/faq-from-inbox";
import { randomLetters } from "@/lib/random-letters";
import {
  type Conversation,
  type InboxSetting,
  MAX_MESSAGE,
  MAX_SAVED,
  MAX_SAVED_TEXT,
  MAX_SAVED_TITLE,
  type Message,
  type SavedReply,
} from "@/lib/inbox-rules";

type Thread = { conversation: Conversation; messages: Message[] };
type Filter = "open" | "mine" | "closed" | "all";

const REASONS: Record<string, string> = {
  short: "Write a little more before sending.",
  none: "That conversation is no longer kept.",
  limited: "That is a lot of answers today. Try again later.",
  assign: "That person cannot answer buyers. Give it to someone whose role can.",
  used: "This month's writing jobs are used up. They come back with your next billing month.",
  off: "The writing help is not on for this store.",
  failed: "No suggestion came back. Try again. This try counted as one of this month's writing jobs.",
  notes: "That conversation is no longer kept.",
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const savedId = () => randomLetters(LETTERS, 6);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function post(body: Record<string, unknown>): Promise<Record<string, unknown> & { ok?: boolean; error?: string }> {
  try {
    const response = await fetch("/api/store/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "network" };
  }
}

const fail = (error: unknown) => toast(REASONS[String(error)] ?? "That did not work. Check your connection and try again.");

/** Times the list is asked again by itself for one opening of the page, one a minute while the tab is in view. */
export const INBOX_AUTO_CHECKS = 30;

/** What the inbox says once it stops asking by itself. */
export const INBOX_PAUSED_WORDS = "Automatic checks paused after 30 minutes. Press Check for new messages or reload the page.";

/** What the inbox says when a check did not answer; the last time stays. */
export const CHECK_FAILED_WORDS = "We could not check for new messages just now. Try again in a moment.";

/** "Checked for new messages at 6:03 PM.", in the creator's own clock. */
export function checkedWords(at: number): string {
  return `Checked for new messages at ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
}

/**
 * The studio's inbox (lib/inbox.ts): the conversations on the left, the one
 * chosen on the right with its answer box, saved replies, the person it is
 * given to, and the suggested answer where the writing help is on.
 */
export function InboxStudio({
  me,
  initial,
  first,
  people,
  setting: givenSetting,
  ai,
  canSettings,
  chatBlock,
  readAt,
  faq = null,
}: {
  me: string;
  initial: Conversation[];
  first: Thread | null;
  people: string[];
  setting: InboxSetting;
  ai: { on: boolean; left: number };
  canSettings: boolean;
  /** For whoever may edit the store page: how many more questions it can show, and the studio home where they are edited (630 [HN6](32)). */
  faq?: { room: number; href: string } | null;
  /** Why the chat cannot be turned on: "demo" for the demo store, "setup" for a store not ready yet, "" when it can. */
  chatBlock: "" | "demo" | "setup";
  /** When the server read the conversations on the page, in milliseconds: the first "checked at" said. */
  readAt: number;
}) {
  const [list, setList] = useState(initial);
  const [thread, setThread] = useState<Thread | null>(first);
  const [filter, setFilter] = useState<Filter>("open");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(ai.left);
  const [setting, setSetting] = useState(givenSetting);

  // When the list was last read (484 [IT1], item 5): the page's own reading first, then each check that answered.
  // The list on the page was read by the server at readAt: that is the first check said, once the browser has drawn it.
  const [checkedAt, setCheckedAt] = useState<number>(readAt);
  // Read out only when it says something new to someone who asked, or what stopped: never every minute.
  const [said, setSaid] = useState("");
  const hydrated = useHydrated();
  const [checkFailed, setCheckFailed] = useState(false);
  const [paused, setPaused] = useState(false);

  const refresh = useCallback(async (asked: boolean) => {
    const answer = await post({ action: "list" });
    if (answer.ok && Array.isArray(answer.conversations)) {
      const at = Date.now();
      setList(answer.conversations as Conversation[]);
      setCheckedAt(at);
      setCheckFailed(false);
      if (asked) setSaid(checkedWords(at));
    } else {
      setCheckFailed(true);
      setSaid(CHECK_FAILED_WORDS);
    }
  }, []);

  // New messages while the inbox is open: the list is asked again every minute, while the tab is in view,
  // thirty times at the most for one opening of the page: each is one of the store's studio requests.
  // When it stops, the page says so, so nobody waits for messages that are no longer being looked for.
  useEffect(() => {
    let asked = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      asked += 1;
      void refresh(false);
      // Paused, and said, right after the last one: never a minute late.
      if (asked >= INBOX_AUTO_CHECKS) {
        window.clearInterval(timer);
        setPaused(true);
        setSaid(INBOX_PAUSED_WORDS);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const shown = useMemo(
    () =>
      list.filter((c) =>
        filter === "all" ? true : filter === "closed" ? c.status === "closed" : filter === "mine" ? c.status === "open" && c.assigned === me : c.status === "open",
      ),
    [list, filter, me],
  );

  const put = (conversation: Conversation) => {
    setList((all) => [conversation, ...all.filter((c) => c.id !== conversation.id)].sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === "open" ? -1 : 1)));
    setThread((t) => (t && t.conversation.id === conversation.id ? { ...t, conversation } : t));
  };

  async function choose(id: string) {
    setBusy(true);
    const answer = await post({ action: "open", id });
    setBusy(false);
    if (!answer.ok) return fail(answer.error);
    const next = answer.thread as Thread;
    setThread(next);
    setText("");
    put(next.conversation);
    const url = new URL(window.location.href);
    url.searchParams.set("c", id);
    window.history.replaceState(null, "", url);
  }

  async function reply(event: React.FormEvent) {
    event.preventDefault();
    if (!thread || busy) return;
    setBusy(true);
    const answer = await post({ action: "reply", id: thread.conversation.id, text });
    setBusy(false);
    if (!answer.ok) return fail(answer.error);
    const next = answer.thread as Thread;
    setThread(next);
    put(next.conversation);
    setText("");
    toast(answer.emailed ? `Sent: in their chat, and emailed to ${next.conversation.email}.` : "Kept in the conversation. The email could not go just now; they see it in their chat.");
  }

  async function act(body: Record<string, unknown>, done: string) {
    if (!thread) return;
    setBusy(true);
    const answer = await post({ ...body, id: thread.conversation.id });
    setBusy(false);
    if (!answer.ok) return fail(answer.error);
    put(answer.conversation as Conversation);
    toast(done);
  }

  async function suggest() {
    if (!thread) return;
    setBusy(true);
    const answer = await post({ action: "suggest", id: thread.conversation.id });
    setBusy(false);
    if (!answer.ok) return fail(answer.error);
    setText(String(answer.text ?? ""));
    setLeft(Number(answer.left) || 0);
    toast("A suggestion is in the box. Read it and change what you need before sending.");
  }

  async function saveSetting(body: Record<string, unknown>, done: string) {
    setBusy(true);
    const answer = await post(body);
    setBusy(false);
    if (!answer.ok) return fail(answer.error);
    setSetting(answer.inbox as InboxSetting);
    toast(done);
  }

  const c = thread?.conversation;
  const counts = {
    open: list.filter((x) => x.status === "open").length,
    mine: list.filter((x) => x.status === "open" && x.assigned === me).length,
    closed: list.filter((x) => x.status === "closed").length,
    all: list.length,
  };

  return (
    <div className="space-y-10">
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section aria-label="Conversations" className="card p-3">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Which conversations">
            {(["open", "mine", "closed", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-ghost ring-1 ring-line"}`}
              >
                {{ open: "Open", mine: "Mine", closed: "Closed", all: "All" }[f]} · {counts[f]}
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="mt-3 space-y-1" data-inbox-list>
              {shown.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => void choose(x.id)}
                    aria-current={c?.id === x.id ? "true" : undefined}
                    className={`w-full rounded-xl px-3 py-2 text-left transition hover:bg-ink/5 ${c?.id === x.id ? "bg-ink/5 ring-1 ring-line" : ""}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className={`truncate ${x.unread ? "font-semibold" : ""}`}>{x.name || x.email}</span>
                      {x.unread ? (
                        <span className="rounded-full bg-ink px-2 text-xs text-paper" aria-label={`${x.unread} unread`}>
                          {x.unread}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-soft" suppressHydrationWarning>
                      {x.source === "chat" ? "Chat" : x.source === "order" ? "Problem with an order" : "Contact form"} · {x.lastFrom === "store" ? "Answered" : "Waiting"} · {when(x.lastAt)}
                      {x.assigned ? ` · ${x.assigned === me ? "You" : x.assigned}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 px-2 pb-2 text-sm text-ink-soft">
              {filter === "open" ? "Nothing waiting. Messages from your chat and your contact form land here." : "Nothing here."}
            </p>
          )}
          <button type="button" className="btn btn-ghost btn-sm mt-3 ring-1 ring-line" onClick={() => void refresh(true)}>
            Check for new messages
          </button>
          {/* When the list was last read, and when automatic checks stopped: always there to read, never announced each minute. */}
          <p className="mt-2 px-1 text-sm text-ink-soft" data-inbox-checked="">
            {!hydrated ? "" : checkFailed ? CHECK_FAILED_WORDS : checkedWords(checkedAt)}
            {paused ? ` ${INBOX_PAUSED_WORDS}` : ""}
          </p>
          {/* Read out politely, never taking the focus (3.2.5): a check someone asked for, a failure, the pause. */}
          <p className="sr-only" role="status" aria-live="polite">{said}</p>
        </section>

        <section aria-label="The conversation" className="card p-5" data-inbox-thread>
          {c && thread ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="t-h3 truncate">{c.name || c.email}</h2>
                  <p className="text-sm text-ink-soft" suppressHydrationWarning>
                    <a className="underline" href={`mailto:${c.email}`}>
                      {c.email}
                    </a>{" "}
                    · {c.source === "chat" ? "Chat on your store" : c.source === "order" ? "A buyer's problem with an order" : "Your contact form"} · since {when(c.startedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm">
                    <span className="sr-only">Given to</span>
                    <select className="field py-1.5 text-sm" value={c.assigned} disabled={busy} onChange={(e) => void act({ action: "assign", email: e.target.value }, e.target.value ? `Given to ${e.target.value === me ? "you" : e.target.value}.` : "Given to nobody.")}>
                      <option value="">Given to nobody</option>
                      {people.map((p) => (
                        <option key={p} value={p}>
                          {p === me ? `You (${p})` : p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    className="btn btn-ghost btn-sm ring-1 ring-line"
                    onClick={() => void act({ action: "status", status: c.status === "open" ? "closed" : "open" }, c.status === "open" ? "Closed. It opens again if they write." : "Open again.")}
                  >
                    {c.status === "open" ? "Close" : "Open again"}
                  </button>
                </div>
              </div>
              {/* Block this person in the store's messages, with a note for the creator alone (567 [GD1] (f)). */}
              <InboxBlock key={c.id} id={c.id} post={post} />
              <ol className="mt-5 max-h-[28rem] space-y-3 overflow-y-auto pr-1" aria-label="Messages">
                {thread.messages.map((m, i) => (
                  <li key={`${m.at}-${i}`} className={m.from === "store" ? "ml-10 text-right" : "mr-10"}>
                    <p className={`inline-block whitespace-pre-line rounded-2xl px-4 py-2 text-left ${m.from === "store" ? "bg-ink text-paper" : "bg-ink/5 ring-1 ring-line"}`}>{m.text}</p>
                    <p className="mt-0.5 text-xs text-ink-soft" suppressHydrationWarning>
                      {m.from === "store" ? (m.by === me ? "You" : m.by || "Your store") : c.name || c.email} · {when(m.at)}
                    </p>
                  </li>
                ))}
              </ol>
              <form onSubmit={reply} className="mt-5 space-y-3">
                <label className="block">
                  <span className="field-label">Your answer</span>
                  <textarea className="field mt-1 w-full" rows={5} maxLength={MAX_MESSAGE} required value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy || text.trim().length < 2}>
                    Send the answer
                  </button>
                  {setting.saved.length ? (
                    <label>
                      <span className="sr-only">Put in a saved reply</span>
                      <select
                        className="field py-1.5 text-sm"
                        value=""
                        onChange={(e) => {
                          const picked = setting.saved.find((s) => s.id === e.target.value);
                          if (picked) setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${picked.text}` : picked.text));
                        }}
                      >
                        <option value="">Put in a saved reply…</option>
                        {setting.saved.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {ai.on ? (
                    <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" disabled={busy || left <= 0} onClick={() => void suggest()}>
                      Suggest an answer · {left} left this month
                    </button>
                  ) : null}
                </div>
                <p className="text-xs text-ink-soft">
                  It shows in their chat if it is open, and goes to {c.email} by email{c.source === "chat" ? ", with a link back to the conversation" : ""}. A suggested answer is written from your store&apos;s questions and
                  answers and this conversation; their address, phone numbers and links are taken out before it is written.
                </p>
              </form>
              {faq ? <FaqFromInbox key={`${c.id}-${thread.messages.length}`} messages={thread.messages} name={c.name} room={faq.room} studioHref={faq.href} /> : null}
            </>
          ) : (
            <p className="text-ink-soft">Choose a conversation to read and answer it.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="chat-heading" className="card p-6">
        <h2 id="chat-heading" className="t-h3">
          The chat on your store
        </h2>
        <p className="mt-2 max-w-2xl text-ink-soft">
          A button in the corner of every page of your store. A visitor writes with their email; your answer shows in their chat while the page is open, and
          goes to their email too. You are emailed when someone writes, at most every half hour for each conversation.
        </p>
        {canSettings ? (
          <label className="mt-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={setting.chat}
              disabled={busy || (chatBlock !== "" && !setting.chat)}
              onChange={(e) => void saveSetting({ action: "chat", on: e.target.checked }, e.target.checked ? "The chat is on your store." : "The chat is off.")}
            />
            <span>Show the chat on my store</span>
          </label>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">The chat is {setting.chat ? "on" : "off"}. The owner or an Admin turns it on or off.</p>
        )}
        {chatBlock === "demo" ? (
          <p className="mt-2 text-sm text-ink-soft">The demo store takes no messages: a chat there would reach nobody. It works on your own store.</p>
        ) : chatBlock === "setup" ? (
          <p className="mt-2 text-sm text-ink-soft">The chat can be turned on once your store has its email address and is not paused.</p>
        ) : null}
      </section>

      <SavedReplies saved={setting.saved} busy={busy} onSave={(saved, done) => void saveSetting({ action: "saved", saved }, done)} />
    </div>
  );
}

function SavedReplies({ saved, busy, onSave }: { saved: SavedReply[]; busy: boolean; onSave: (saved: SavedReply[], done: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <section aria-labelledby="saved-heading" className="card p-6">
      <h2 id="saved-heading" className="t-h3">
        Saved replies
      </h2>
      <p className="mt-2 max-w-2xl text-ink-soft">Answers you give often, put in with one choice and changed before sending. Up to {MAX_SAVED}.</p>
      {saved.length ? (
        <ul className="mt-4 space-y-2">
          {saved.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 rounded-xl px-3 py-2 ring-1 ring-line">
              <span className="min-w-0">
                <span className="font-medium">{s.title}</span>
                <span className="mt-0.5 block whitespace-pre-line text-sm text-ink-soft">{s.text}</span>
              </span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onSave(saved.filter((x) => x.id !== s.id), "Removed.")}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {saved.length < MAX_SAVED ? (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave([...saved, { id: savedId(), title: title.trim(), text: body.trim() }], "Saved.");
            setTitle("");
            setBody("");
          }}
        >
          <label>
            <span className="field-label">Name</span>
            <input className="field mt-1 w-full py-2" required maxLength={MAX_SAVED_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Where is my download?" />
          </label>
          <label>
            <span className="field-label">The reply</span>
            <textarea className="field mt-1 w-full" rows={3} required maxLength={MAX_SAVED_TEXT} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !title.trim() || body.trim().length < 2}>
              Save the reply
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
