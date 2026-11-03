"use client";

import { useState } from "react";
import { MAX_CART } from "@/lib/cart-rules";
import { LINK_CODE_PATTERN } from "@/lib/code-link";
import { MAX_NAME, linkName, shortUrl } from "@/lib/short-link-rules";
import { POST_PLACES } from "@/lib/share-links";

type Made = { code: string; name: string; made: number; target: { kind: string } };

const SHORT_ERRORS: Record<string, string> = {
  name: "Give the post a name, like october-reel.",
  taken: "Another short link already has that name. Choose another.",
  target: "One of these products is not on your store anymore. Reload the page.",
  full: "Your store has as many short links as it can keep. End one under Short links first.",
  forbidden: "Your role on this store cannot make short links.",
};

/**
 * A ready cart link for a post or an email (624 [SZ8](23), unit 2): the
 * creator picks two to MAX_CART of the products a cart can hold and, if they
 * want, one of their discount codes; the link opens the store with those
 * products in the cart (the store page's `restore`) and the code remembered
 * for the checkout (lib/code-link.ts), applied by Stripe only if it is one of
 * their live codes. Nothing is saved: the link is made here, in the browser.
 */
/** The link for these products and code, or "" while it cannot be made: fewer than two, more than MAX_CART, or a code of the wrong shape. */
export function cartLink(address: string, ids: string[], rawCode: string): string {
  const code = rawCode.trim().toUpperCase();
  if (ids.length < 2 || ids.length > MAX_CART || (code !== "" && !LINK_CODE_PATTERN.test(code))) return "";
  return `${address}?restore=${ids.map(encodeURIComponent).join(",")}${code ? `&code=${encodeURIComponent(code)}` : ""}`;
}

export function CartLinkBuilder({ address, products }: { address: string; products: { id: string; title: string }[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [post, setPost] = useState("");
  const [place, setPlace] = useState(POST_PLACES[0]?.place ?? "other");
  const [short, setShort] = useState<string | null>(null);
  const [shortError, setShortError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  async function makeShort() {
    const name = linkName(post);
    if (!name) return setShortError(SHORT_ERRORS.name);
    setMaking(true);
    setShortError(null);
    try {
      const typed = code.trim().toUpperCase();
      const target = typed ? { kind: "cart", ids: picked, code: typed } : { kind: "cart", ids: picked };
      const response = await fetch("/api/store/short-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", name: post, place, target }) });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; links?: Made[] } | null;
      if (!data?.ok || !Array.isArray(data.links)) return setShortError(SHORT_ERRORS[data?.error ?? ""] ?? "The short link could not be made just now. Try again in a moment.");
      const made = data.links.filter((l) => l.name === name && l.target?.kind === "cart").sort((a, b) => b.made - a.made)[0];
      setShort(made ? shortUrl(made.code) : null);
      if (!made) setShortError("The short link was made; find it under Short links.");
    } catch {
      setShortError("The short link could not be made just now. Try again in a moment.");
    } finally {
      setMaking(false);
    }
  }
  const typed = code.trim().toUpperCase();
  const codeOk = typed === "" || LINK_CODE_PATTERN.test(typed);
  const link = cartLink(address, picked, code);

  if (products.length < 2) return null;
  return (
    <section id="cart-link" aria-labelledby="cart-link-title" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
      <h2 id="cart-link-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        A link to a ready cart
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        {`For a post or an email: whoever opens it finds these products already in your store's cart, and checks out with one payment. Choose 2 to ${MAX_CART}.`}
      </p>
      <fieldset className="mt-4">
        <legend className="field-label">Products in the cart</legend>
        <ul className="mt-1.5 space-y-1">
          {products.map((p) => {
            const on = picked.includes(p.id);
            const full = !on && picked.length >= MAX_CART;
            return (
              <li key={p.id}>
                <label className={`flex min-h-11 items-center gap-3 rounded-xl px-2 ${full ? "text-ink-mute" : "cursor-pointer hover:bg-paper"}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={full}
                    onChange={(e) => {
                      setCopied(false);
                      setShort(null);
                      setPicked((list) => (e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)));
                    }}
                    className="h-5 w-5 shrink-0 accent-[var(--violet)]"
                  />
                  <span className="min-w-0 flex-1">{p.title}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {picked.length >= MAX_CART ? <p className="mt-1 text-xs text-ink-soft">{`A cart holds ${MAX_CART} products at most.`}</p> : null}
      </fieldset>
      <label className="mt-4 block max-w-xs" htmlFor="cart-link-code">
        <span className="field-label">Discount code (optional)</span>
        <input
          id="cart-link-code"
          value={code}
          onChange={(e) => {
            setCopied(false);
            setShort(null);
            setCode(e.target.value);
          }}
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby="cart-link-code-help"
          aria-invalid={!codeOk}
          className="field font-mono uppercase"
        />
        <span id="cart-link-code-help" className="mt-1 block text-xs text-ink-soft">
          {codeOk
            ? "One of your codes under Discount codes. It goes on at checkout by itself if it is live and fits the order; otherwise the checkout opens with the box, as usual. A sale already on takes its place."
            : "A code is 3 to 24 letters, numbers or hyphens."}
        </span>
      </label>
      <div className="mt-4" aria-live="polite">
        {link ? (
          <>
            <p className="field-label">Your link</p>
            <p className="mt-1 break-all rounded-xl bg-paper px-3 py-2 font-mono text-sm text-ink">{link}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy the link"}
            </button>
            <div className="mt-5 border-t border-line pt-4">
              <p className="field-label">Or a short link for one post</p>
              <p className="mt-1 text-xs text-ink-soft">
                A short address and its QR code, counted under Short links with the visits, sales and revenue of that post.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block" htmlFor="cart-link-post">
                  <span className="field-label">The post&apos;s name</span>
                  <input id="cart-link-post" className="field mt-1 py-2" maxLength={MAX_NAME + 10} value={post} onChange={(e) => setPost(e.target.value)} placeholder="october-reel" />
                </label>
                <label className="block" htmlFor="cart-link-place">
                  <span className="field-label">Where it is posted</span>
                  <select id="cart-link-place" className="field mt-1 w-full py-2" value={place} onChange={(e) => setPlace(e.target.value)}>
                    {POST_PLACES.map((p) => (
                      <option key={p.place} value={p.place}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="button" className="btn btn-secondary btn-sm mt-3" aria-busy={making} disabled={making} onClick={() => void makeShort()}>
                {making ? "Making it…" : "Make a short link"}
              </button>
              {short ? (
                <p className="mt-2 text-sm" role="status">
                  {"Your short link: "}
                  <span className="break-all font-mono text-ink">{short}</span>
                </p>
              ) : null}
              {shortError ? (
                <p className="notice notice-error mt-2" role="alert">
                  {shortError}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-soft">{picked.length < 2 ? "Choose at least two products to make the link." : "Fix the code to make the link."}</p>
        )}
      </div>
    </section>
  );
}
