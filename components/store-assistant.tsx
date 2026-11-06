"use client";

import { useEffect, useRef, useState } from "react";
import { EmailInput } from "@/components/email-input";
import { assistantWords } from "@/lib/buyer-words/assistant";
import { MAX_ASSISTANT_QUESTION, MIN_ASSISTANT_QUESTION } from "@/lib/store-assistant-rules";

type Turn = { at: number; from: "buyer" | "ai"; text: string; status?: "answer" | "unknown" | "handoff" | "sent" };
type Thread = { token: string; turns: Turn[] };
type Notice = "short" | "slow" | "error" | "closed" | "email";

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const storageKey = (handle: string) => `mm-assist:${handle}`;

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
    return token && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; thread?: Thread | null; error?: string }> {
  try {
    const response = await fetch("/api/store/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as { ok: boolean; thread?: Thread | null; error?: string };
  } catch {
    return { ok: false, error: "error" };
  }
}

const noticeOf = (error: string | undefined): Notice => (["short", "slow", "closed", "email"] as const).find((n) => n === error) ?? (error === "question" ? "short" : error === "limited" ? "slow" : "error");

/**
 * The Store assistant's chat in the corner of every page of a store
 * (lib/store-assistant.ts), shown only while the creator has it on and the
 * add-on is paid for. Every reply sits under the "AI assistant" label, drawn
 * here and never by the model. Nothing is asked of the server until the
 * visitor writes, or comes back to a conversation this browser holds. When
 * the assistant does not know, when the question is for the creator, or
 * when the month's replies are used, the chat becomes a form that leaves
 * the question for the creator, with the address typed to be answered.
 */
export function StoreAssistant({ handle, storeName, language }: { handle: string; storeName: string; language: string }) {
  const w = assistantWords(language);
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [handing, setHanding] = useState(false);
  const [spent, setSpent] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [sent, setSent] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // A conversation this browser had here in the last day: read once, when the chat is first opened.
  useEffect(() => {
    if (!open || thread) return;
    const token = recall(handle);
    if (!token) return;
    void post({ handle, action: "read", token }).then((result) => {
      if (result.ok && result.thread) setThread(result.thread);
      else remember(handle, null);
    });
  }, [open, thread, handle]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [thread?.turns.length, open, handing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setDeleted(false);
    const asked = text;
    const result = await post({ handle, action: "ask", token: thread?.token, text });
    setBusy(false);
    if (!result.ok || !result.thread) {
      if (result.error === "spent") {
        setSpent(true);
        setHanding(true);
        return;
      }
      setNotice(noticeOf(result.error));
      return;
    }
    remember(handle, result.thread.token);
    setThread(result.thread);
    const last = result.thread.turns[result.thread.turns.length - 1];
    // Handed over: the same question goes in the form, ready to send to the creator.
    setText(last?.status === "handoff" ? asked : "");
    if (last?.status === "handoff") setHanding(true);
  }

  async function handOff(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await post({ handle, action: "handoff", token: thread?.token, email, name, text });
    setBusy(false);
    if (!result.ok) {
      setNotice(noticeOf(result.error));
      return;
    }
    if (result.thread) setThread(result.thread);
    setSent(true);
    setHanding(false);
    setText("");
  }

  async function forget() {
    if (thread) await post({ handle, action: "delete", token: thread.token });
    remember(handle, null);
    setThread(null);
    setHanding(false);
    setSent(false);
    setDeleted(true);
  }

  const lastBuyer = [...(thread?.turns ?? [])].reverse().find((t) => t.from === "buyer")?.text ?? "";
  const startHandoff = () => {
    setText((typed) => typed || lastBuyer);
    setHanding(true);
  };

  return (
    <div className="st-chat fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3 print:hidden" data-store-assistant>
      {open ? (
        <div role="dialog" aria-label={w.title(storeName)} className="st-card st-chat-panel flex max-h-[min(38rem,80vh)] w-[min(23rem,calc(100vw-2rem))] flex-col p-4 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-lg font-semibold leading-snug">{w.title(storeName)}</h2>
            <button type="button" onClick={() => setOpen(false)} className="st-muted text-sm underline" aria-label={w.close}>
              {w.close}
            </button>
          </div>
          <p className="st-muted mt-1 text-xs">
            <span className="st-chat-badge mr-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-current">{w.label}</span>
            {w.intro(storeName)}
          </p>
          <div ref={list} className="mt-3 flex-1 space-y-2 overflow-y-auto" aria-live="polite" data-assistant-thread>
            {(thread?.turns ?? []).map((t, i) => (
              <div key={`${t.at}-${i}`} className={t.from === "buyer" ? "ml-8 text-right" : "mr-8"}>
                {t.from === "ai" ? <p className="st-muted mb-0.5 text-xs font-semibold uppercase tracking-wide" data-ai-label>{w.label}</p> : null}
                <p className={`inline-block whitespace-pre-line rounded-xl px-3 py-2 text-left text-sm ${t.from === "buyer" ? "st-chat-mine" : "st-chat-theirs"}`}>{t.text}</p>
                {t.from === "ai" && (t.status === "unknown" || t.status === "handoff") && i === (thread?.turns.length ?? 0) - 1 && !handing ? (
                  <button type="button" className="st-muted mt-1 block text-xs underline" onClick={startHandoff}>
                    {w.askCreator(storeName)}
                  </button>
                ) : null}
                {t.from === "buyer" ? <p className="st-muted mt-0.5 text-xs">{w.you}</p> : null}
              </div>
            ))}
          </div>
          {spent ? <p className="mt-2 text-sm">{w.spent(storeName)}</p> : null}
          {sent ? <p className="st-muted mt-2 text-xs">{w.handoffDone(storeName)}</p> : null}
          {deleted ? <p className="st-muted mt-2 text-xs">{w.deleted}</p> : null}
          {notice ? (
            <p role="alert" className="mt-2 text-sm font-medium">
              {w.notices[notice]}
            </p>
          ) : null}
          {handing ? (
            <form onSubmit={handOff} className="mt-3 space-y-2" data-assistant-handoff>
              <div>
                <label htmlFor="store-assistant-email" className="st-label block text-sm">{w.email}</label>
                <EmailInput id="store-assistant-email" required autoComplete="email" value={email} onChange={setEmail} className="st-field mt-1 w-full" language={language} store />
              </div>
              <label className="block">
                <span className="st-label text-sm">{w.name}</span>
                <input maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="st-field mt-1 w-full" />
              </label>
              <label className="block">
                <span className="sr-only">{w.placeholder}</span>
                <textarea rows={2} maxLength={MAX_ASSISTANT_QUESTION} value={text} placeholder={w.placeholder} onChange={(e) => setText(e.target.value)} className="st-field mt-1 w-full" />
              </label>
              <p className="st-muted text-xs">{w.handoffConsent(storeName)}</p>
              <div className="flex items-center justify-between gap-3">
                <button type="submit" disabled={busy} className="btn st-btn">
                  {w.handoffSend(storeName)}
                </button>
                {!spent ? (
                  <button type="button" className="st-muted text-xs underline" onClick={() => setHanding(false)}>
                    {w.close}
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <form onSubmit={ask} className="mt-3 space-y-2">
              <label className="block">
                <span className="sr-only">{w.placeholder}</span>
                <textarea
                  required
                  minLength={MIN_ASSISTANT_QUESTION}
                  maxLength={MAX_ASSISTANT_QUESTION}
                  rows={2}
                  value={text}
                  placeholder={w.placeholder}
                  onChange={(e) => setText(e.target.value)}
                  className="st-field mt-1 w-full"
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <button type="submit" disabled={busy} aria-busy={busy} className="btn st-btn">
                  {w.send}
                </button>
                <button type="button" className="st-muted text-xs underline" onClick={startHandoff}>
                  {w.askCreator(storeName)}
                </button>
              </div>
            </form>
          )}
          <p className="st-muted mt-3 text-xs leading-snug">
            {w.privacy}{" "}
            {thread ? (
              <button type="button" className="underline" onClick={() => void forget()}>
                {w.deleteChat}
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="btn st-btn shadow-lg">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
        </svg>
        {open ? w.close : w.launcher}
      </button>
    </div>
  );
}
