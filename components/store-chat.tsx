"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmailInput } from "@/components/email-input";
import { chatWords } from "@/lib/buyer-words/chat";
import { CHAT_TOKEN, MAX_MESSAGE, MAX_NAME, MIN_MESSAGE, POLL_FOR_MINUTES, POLL_SECONDS } from "@/lib/inbox-rules";

type Line = { at: number; from: "visitor" | "store"; text: string };
type Thread = { token: string; status: "open" | "closed"; messages: Line[] };
type Notice = "email" | "short" | "limited" | "closed" | "error" | "gone";

const clock = () => Date.now();
const storageKey = (handle: string) => `mm-chat:${handle}`;

function remember(handle: string, token: string | null): void {
  try {
    if (token) window.localStorage.setItem(storageKey(handle), token);
    else window.localStorage.removeItem(storageKey(handle));
  } catch {
    // A browser that keeps nothing: the chat still works while the page is open.
  }
}

function recall(handle: string): string | null {
  try {
    const token = window.localStorage.getItem(storageKey(handle));
    return token && CHAT_TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function ask(body: Record<string, unknown>): Promise<{ ok: true; thread: Thread } | { ok: false; error: Notice }> {
  try {
    const response = await fetch("/api/store/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json()) as { ok?: boolean; thread?: Thread; error?: string };
    if (data.ok && data.thread) return { ok: true, thread: data.thread };
    const error = (["email", "short", "limited", "closed", "gone"] as const).find((e) => e === data.error) ?? "error";
    return { ok: false, error };
  } catch {
    return { ok: false, error: "error" };
  }
}

/**
 * The chat on a store's pages (lib/inbox.ts), shown only where the creator
 * turned it on. Nothing is asked of the server until the visitor writes, or
 * comes back to a conversation they started (its token is kept in this
 * browser, or arrives in the link of the email that carried an answer).
 * While open, it asks for an answer every POLL_SECONDS, and stops
 * POLL_FOR_MINUTES after the last thing typed: the answer goes by email too.
 */
export function StoreChat({ handle, storeName, language }: { handle: string; storeName: string; language: string }) {
  const w = chatWords(language);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const typedAt = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  // A conversation started here before, or the link in an answer's email.
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("chat");
    if (fromLink && CHAT_TOKEN.test(fromLink)) {
      remember(handle, fromLink);
      // Only the browser knows the address and what it kept: read once, after the first paint.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToken(fromLink);
      typedAt.current = clock();
      setOpen(true);
      return;
    }
    setToken(recall(handle));
  }, [handle]);

  const read = useCallback(async () => {
    if (!token) return;
    const result = await ask({ action: "read", token });
    if (result.ok) setThread(result.thread);
    else if (result.error === "gone") {
      remember(handle, null);
      setToken(null);
      setThread(null);
      setNotice("gone");
    }
  }, [token, handle]);

  useEffect(() => {
    if (!open || !token) return;
    const first = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => {
      if (clock() - typedAt.current > POLL_FOR_MINUTES * 60_000) return;
      if (document.visibilityState === "visible") void read();
    }, POLL_SECONDS * 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [open, token, read]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [thread?.messages.length, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    typedAt.current = clock();
    setBusy(true);
    setNotice(null);
    const result = token ? await ask({ action: "send", token, text }) : await ask({ action: "start", handle, email, name, text });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error);
      if (result.error === "gone") {
        remember(handle, null);
        setToken(null);
        setThread(null);
      }
      return;
    }
    remember(handle, result.thread.token);
    setToken(result.thread.token);
    setThread(result.thread);
    setText("");
    setJustSent(true);
  }

  function startOver() {
    remember(handle, null);
    setToken(null);
    setThread(null);
    setJustSent(false);
    setNotice(null);
  }

  return (
    <div className="st-chat fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3 print:hidden">
      {open ? (
        <div role="dialog" aria-label={w.title(storeName)} className="st-card st-chat-panel flex max-h-[min(36rem,75vh)] w-[min(22rem,calc(100vw-2rem))] flex-col p-4 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-lg font-semibold leading-snug">{w.title(storeName)}</h2>
            <button type="button" onClick={() => setOpen(false)} className="st-muted text-sm underline" aria-label={w.close}>
              {w.close}
            </button>
          </div>
          {thread ? (
            <div ref={list} className="mt-3 flex-1 space-y-2 overflow-y-auto" aria-live="polite" data-chat-thread>
              {thread.messages.map((m, i) => (
                <div key={`${m.at}-${i}`} className={m.from === "visitor" ? "ml-8 text-right" : "mr-8"}>
                  <p className={`inline-block whitespace-pre-line rounded-xl px-3 py-2 text-left text-sm ${m.from === "visitor" ? "st-chat-mine" : "st-chat-theirs"}`}>{m.text}</p>
                  <p className="st-muted mt-0.5 text-xs">{m.from === "visitor" ? w.you : storeName}</p>
                </div>
              ))}
              {thread.status === "closed" ? <p className="st-muted text-xs">{w.closedNote}</p> : null}
            </div>
          ) : (
            <p className="st-muted mt-2 text-sm">{w.intro(storeName)}</p>
          )}
          {justSent && thread ? <p className="st-muted mt-2 text-xs">{w.sent}</p> : null}
          {notice ? (
            <p role="alert" className="mt-2 text-sm font-medium">
              {w.notices[notice]}
            </p>
          ) : null}
          <form onSubmit={submit} className="mt-3 space-y-2">
            {!token ? (
              <>
                <div>
                  <label htmlFor="store-chat-email" className="st-label block text-sm">{w.email}</label>
                  <EmailInput id="store-chat-email" required autoComplete="email" value={email} onChange={setEmail} className="st-field mt-1 w-full" language={language} store />
                </div>
                <label className="block">
                  <span className="st-label text-sm">{w.name}</span>
                  <input maxLength={MAX_NAME} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="st-field mt-1 w-full" />
                </label>
              </>
            ) : null}
            <label className="block">
              <span className={token ? "sr-only" : "st-label text-sm"}>{w.message}</span>
              <textarea
                required
                minLength={MIN_MESSAGE}
                maxLength={MAX_MESSAGE}
                rows={token ? 2 : 3}
                value={text}
                onChange={(e) => {
                  typedAt.current = clock();
                  setText(e.target.value);
                }}
                className="st-field mt-1 w-full"
              />
            </label>
            <div className="flex items-center justify-between gap-3">
              <button type="submit" disabled={busy} className="btn st-btn">
                {w.send}
              </button>
              {token ? (
                <button type="button" onClick={startOver} className="st-muted text-xs underline">
                  {w.newChat}
                </button>
              ) : (
                <span className="st-muted text-xs">{w.privacy}</span>
              )}
            </div>
          </form>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          typedAt.current = clock();
          setOpen((v) => !v);
        }}
        className="btn st-btn shadow-lg"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
        </svg>
        {open ? w.close : w.launcher}
      </button>
    </div>
  );
}
