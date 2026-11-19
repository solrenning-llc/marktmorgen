"use client";

import { ConfirmAction } from "@/components/confirm-action";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AiAssist } from "@/components/ai-assist";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";
import { useLeaveGuard } from "@/components/leave-guard";
import { PostBody } from "@/components/blog-body";
import { BLOG_OUTLINES, OUTLINE_LEFT_MESSAGE, outlinePromptsLeft } from "@/lib/blog-outline";
import { type StoreLook, lookStyle } from "@/lib/store-look";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";

const MAX_TITLE = 120;
const MAX_BODY = 20_000;

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  title: "Give the post a title.",
  body: "Write the post before saving it.",
  full: "A blog holds up to 200 posts. Delete one first.",
  unknown: "That post or its count could not be verified. Reload the blog to check it.",
  unconfirmed: "Your change could not be confirmed. Reload the blog and check it before trying again.",
  none: "This account has no store yet.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  outline_left: OUTLINE_LEFT_MESSAGE,
};

export type EditedPost = { id: string | null; title: string; body: string; product: string | null; draft: boolean; href: string | null };

/**
 * Writing one post of the store's blog (lib/store-blog.ts): a title, the
 * words — plain text, as a product's description is, with "## " for a
 * heading — and, if the creator likes, one of their products to end on.
 * Published, kept as a draft, or deleted from here; a draft is seen by no
 * one but the studio.
 */
export function BlogEditor({ post, products, back, look, language = "en" }: { post: EditedPost; products: { id: string; title: string }[]; back: string; /** The store's look, so the preview is drawn as the blog is. */ look: StoreLook; /** The store's language, so the preview is marked as the blog is. */ language?: LanguageCode }) {
  const router = useRouter();
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [product, setProduct] = useState(post.product ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  // The preview starts at a phone's width, where most posts are read (487 [IT4], pattern 7).
  const [phone, setPhone] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outline, setOutline] = useState(BLOG_OUTLINES[0].id);
  // Offered on a new, empty post only, decided when it opens: it never comes and goes while the creator types.
  const [offerOutline, setOfferOutline] = useState(() => !post.id && !post.body.trim());
  // Each refusal counts, so the same words said again are announced again.
  const [tries, setTries] = useState(0);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  // A post written and not saved is never lost to a click away (487 [IT4], item 6): leaving asks first, as the email studio does.
  const [done, setDone] = useState(false);
  // What a confirmed save sent, until the saved post comes back: what is typed after it stays guarded, and is kept.
  const [sent, setSent] = useState<{ title: string; body: string; product: string } | null>(null);
  const base = sent ?? { title: post.title, body: post.body, product: post.product ?? "" };
  const dirty = title !== base.title || body !== base.body || product !== base.product;
  useLeaveGuard(dirty && !done);
  // The saved post comes back as new props (router.refresh): from then on, changes to it are guarded again.
  const [seen, setSeen] = useState(post);
  if (seen !== post) {
    setSeen(post);
    // Just saved: take the post as the server kept it (it tidies spaces and blank lines), so nothing reads as unsaved;
    // but a field changed since the save keeps what was typed, and stays unsaved.
    if (sent) {
      if (title === sent.title) setTitle(post.title);
      if (body === sent.body) setBody(post.body);
      if (product === sent.product) setProduct(post.product ?? "");
      setSent(null);
    }
    setDone(false);
  }

  async function send(payload: Record<string, unknown>, kind: string) {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch("/api/store/blog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; post?: { id: string }; countUnavailable?: boolean };
      if (!data.ok) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        setTries((n) => n + 1);
        return null;
      }
      return data;
    } catch {
      setError(MESSAGES.server_error);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function save(draft: boolean) {
    // Said at once, before asking the server, which refuses it too.
    const left = draft ? [] : outlinePromptsLeft(title, body);
    if (left.length) {
      setError(`${OUTLINE_LEFT_MESSAGE} The first one left: ${left[0]}`);
      setTries((n) => n + 1);
      return;
    }
    const data = await send({ action: "save", id: post.id, title, body, product: product || null, draft }, draft ? "draft" : "publish");
    if (!data) return;
    setSent({ title, body, product });
    toast(data.countUnavailable ? "Post saved. The published count could not be confirmed. Reload the blog to check it." : draft ? "Saved as a draft." : "Published on your blog.");
    router.push(`${back}${back.includes("?") ? "&" : "?"}edit=${data.post?.id ?? ""}`);
    router.refresh();
  }

  async function remove() {
    if (!post.id) return;
    const data = await send({ action: "delete", id: post.id }, "delete");
    if (!data) return;
    setDone(true);
    toast(data.countUnavailable ? "Post deleted. The published count could not be confirmed. Reload the blog to check it." : "Post deleted.");
    router.push(back);
    router.refresh();
  }

  // The post as the blog draws it (components/blog-body.tsx), from what is typed now, in the store's look.
  const toggle = (on: boolean) => `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`;
  const preview = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-soft">As it is published</p>
        <div role="group" aria-label="Preview width" className="inline-flex rounded-full bg-sand p-1">
          <button type="button" className={toggle(phone)} aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone
          </button>
          <button type="button" className={toggle(!phone)} aria-pressed={!phone} onClick={() => setPhone(false)}>
            Wide
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-soft">The same words as in the editor, laid out as your blog shows them. Nothing in it can be pressed here.</p>
      <div className="mt-1 overflow-hidden rounded-2xl ring-1 ring-line">
        <div
          // Inert: its headings stay out of the page's outline, its links out of the Tab order and out of reach of a click that would leave the draft.
          inert
          // In the store's language, as the blog is, so its words would be read in the right language (3.1.2).
          lang={LANGUAGES[language]?.locale ?? "en-US"}
          className={`st-page st-theme-${look.theme} mx-auto px-4 pb-8 pt-6`}
          // Wide is the published page's own width (max-w-2xl, 672 px), so lines break where they will.
          style={{ ...(lookStyle(look) as React.CSSProperties), maxWidth: phone ? 390 : 672 }}
        >
          <p className={`font-display font-semibold leading-tight ${phone ? "text-3xl" : "text-4xl"}`}>{title.trim() || "Your title"}</p>
          <div className="mt-4">{body.trim() ? <PostBody body={body} /> : <p className="text-sm">Your words appear here as you write.</p>}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <AiAssist<{ title: string; body: string }>
        title="Write a draft with AI"
        hint="A useful post on the topic you give, in your store's language, from your words and what your store sells. It mentions a product only where it fits. It replaces the title and words here; nothing is saved until you press Publish or Save as draft."
        placeholder="What the post is about, who it is for, the points you want in it."
        payload={() => ({ kind: "blog" })}
        onResult={(draft) => {
          setTitle(draft.title.slice(0, MAX_TITLE));
          setBody(draft.body.slice(0, MAX_BODY));
        }}
        done="Drafted. Read it, make it yours, then publish it or keep it as a draft."
      />
      {/* A ready outline for an empty post (487 [IT4], item 5): its parts in [brackets] are the creator's to write. */}
      {offerOutline ? (
        <div className="rounded-[var(--r-sm)] border border-line bg-white p-4" data-blog-outline="">
          <p className="font-semibold text-ink">Or start from an outline</p>
          <p className="mt-1 text-sm text-ink-soft" id="post-outline-hint">It sets out the parts of a post. Replace each part in [brackets], brackets and all, with your own words. It cannot be published until every one is replaced; you can save it as a draft any time.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="post-outline" className="field-label">Outline</label>
              <select id="post-outline" className="field" value={outline} onChange={(e) => setOutline(e.target.value)} aria-describedby="post-outline-hint">
                {BLOG_OUTLINES.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(body.trim())}
              onClick={() => {
                // Only into an empty post: nothing typed is replaced.
                if (body.trim()) return;
                const chosen = (BLOG_OUTLINES.find((o) => o.id === outline) ?? BLOG_OUTLINES[0]).body;
                setBody(chosen);
                setOfferOutline(false);
                // The button goes with the box: the focus moves to the words, with the first part to replace selected.
                requestAnimationFrame(() => {
                  const field = bodyField.current;
                  if (!field) return;
                  field.focus();
                  const start = chosen.indexOf("[");
                  if (start >= 0) field.setSelectionRange(start, chosen.indexOf("]", start) + 1);
                });
              }}
            >
              Use this outline
            </button>
          </div>
        </div>
      ) : null}
      <div>
        <label htmlFor="post-title" className="field-label">
          Title
        </label>
        <input id="post-title" className="field" maxLength={MAX_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor="post-body" className="field-label">
          The post
        </label>
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <div className="min-w-0">
            <textarea ref={bodyField} id="post-body" className="field font-[inherit]" rows={18} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="post-body-hint" />
            <p id="post-body-hint" className="field-hint mt-1">
              {`A blank line starts a paragraph, a line starting with “## ” is a heading, one starting with “- ” is a point in a list, and a written-out https address becomes a link. ${(MAX_BODY - body.length).toLocaleString("en-US")} characters left.`}
            </p>
          </div>
          {/* Beside the text on a wide screen; on a narrow one, folded. */}
          <div className="hidden xl:block">{preview}</div>
          <details className="xl:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink underline underline-offset-4">See it as it is published</summary>
            <div className="mt-2">{preview}</div>
          </details>
        </div>
      </div>
      <div>
        <label htmlFor="post-product" className="field-label">
          End on one of your products (optional)
        </label>
        <select id="post-product" className="field" value={product} onChange={(e) => setProduct(e.target.value)}>
          <option value="">None</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <p className="field-hint mt-1">Its card, with today&apos;s picture and price, after the last line. Products among the first 24 on your store page can be shown.</p>
      </div>
      {error ? (
        <p key={tries} className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void save(false)}>
          {busy === "publish" ? "Publishing…" : post.id && !post.draft ? "Save and keep it published" : "Publish"}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void save(true)}>
          {busy === "draft" ? "Saving…" : post.id && !post.draft ? "Take it off the blog, as a draft" : "Save as draft"}
        </button>
        {post.href ? (
          <a href={post.href} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
            View it
            <Icon name="external" size={15} />
          <NewTab /></a>
        ) : null}
        {post.id ? (
          <span className="ml-auto">
            <ConfirmAction className="btn btn-ghost text-danger" disabled={busy !== null} busy={busy === "delete"} question="Delete this post? It cannot be brought back." yes={busy === "delete" ? "Deleting…" : "Yes, delete"} onConfirm={remove}>
              <Icon name="trash" size={15} />
              Delete
            </ConfirmAction>
          </span>
        ) : null}
      </div>
    </div>
  );
}
