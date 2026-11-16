"use client";

import { useContext, useId, useState } from "react";
import { Icon } from "@/components/icons";
import { AI_ALLOWANCE_UNKNOWN, AiOn, allowanceOf } from "@/components/ai-assist";
import { toast } from "@/components/toast";
import { taggedFor } from "@/lib/share-links";
import type { SalesPage } from "@/lib/sales-page";

type Posts = { x: string; instagram: string; linkedin: string };

/**
 * Posts about a product, drafted with AI (added 9 October 2026; lib/ai.ts,
 * writePosts): one for X and one for LinkedIn, each with the page's address
 * tagged for where it goes (lib/share-links.ts) so the studio's numbers say
 * which brought the visit, and an Instagram caption that points to the link
 * in the bio, where a link can be pressed. Each is the creator's to change
 * and copy; nothing is posted from here.
 */
export function AiPosts({ productId, url, page, what = "page" }: { productId?: string; url: string; page?: () => SalesPage; what?: "page" | "store" }) {
  const ai = useContext(AiOn);
  const [posts, setPosts] = useState<Posts | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [left, setLeft] = useState(allowanceOf(ai));
  const allowanceId = useId();
  if (!ai.on) return null;

  async function write() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Without a product, posts about the whole store (app/api/store/ai, kind "posts").
        body: JSON.stringify(productId ? { kind: "posts", product: productId, page: page?.() } : { kind: "posts" }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Posts; left?: number; error?: string };
      if (data.ok && data.value) {
        const v = data.value;
        setPosts({ x: `${v.x} ${taggedFor(url, "x")}`, instagram: v.instagram, linkedin: `${v.linkedin}\n\n${taggedFor(url, "linkedin")}` });
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setNote(
        data.error === "used"
          ? "This month's writing help is used up. It starts again with your next billing month."
          : data.error === "notes"
            ? "Add a product or a line about your store first: the posts are written from them."
            : "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.",
      );
    } catch {
      setNote("The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Post copied.");
    } catch {
      toast("Select the post and copy it.");
    }
  }

  const places: { key: keyof Posts; label: string; hint: string }[] = [
    { key: "x", label: "X", hint: "With the link, tagged for X." },
    { key: "instagram", label: "Instagram", hint: "Points to the link in your bio: put the page's link there." },
    { key: "linkedin", label: "LinkedIn", hint: "With the link, tagged for LinkedIn." },
  ];

  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        Posts about it, written with AI
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        {`One for X, an Instagram caption and one for LinkedIn, from what ${what === "store" ? "your store sells" : "this page says"}, in your store's language. Nothing is posted for you: change them, then copy.`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void write()} disabled={busy || left === null || left <= 0} aria-busy={busy} aria-describedby={allowanceId}>
          {busy ? "Writing…" : posts ? "Write three more" : "Write three posts"}
        </button>
        <span id={allowanceId} className="text-xs text-ink-soft">{left === null ? AI_ALLOWANCE_UNKNOWN : `${left} left this month. Started attempts count, even if they fail.`}</span>
      </div>
      {note ? (
        <p className="notice notice-error mt-2 text-sm" role="alert">
          {note}
        </p>
      ) : null}
      {posts ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {places.map((place) => (
            <div key={place.key} className="min-w-0 rounded-xl bg-white p-3 ring-1 ring-line">
              <label htmlFor={`post-${place.key}`} className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">
                {place.label}
              </label>
              <textarea
                id={`post-${place.key}`}
                className="field mt-1 text-sm"
                rows={place.key === "x" ? 4 : 8}
                value={posts[place.key]}
                onChange={(e) => setPosts({ ...posts, [place.key]: e.target.value })}
              />
              <p className="mt-1 text-xs text-ink-soft">{place.hint}</p>
              <button type="button" className="btn btn-ghost btn-sm mt-2 ring-1 ring-line" onClick={() => void copy(posts[place.key])}>
                <Icon name="copy" size={15} />
                {`Copy the ${place.label} post`}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
