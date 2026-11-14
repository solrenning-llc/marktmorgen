"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/lib/store";
import { useStudioHref } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  free: "A private podcast is sold. Give it a price first.",
  options: "Take the price options off first: a podcast has one price.",
  delivery: "Take the file or link off first: a podcast delivers its episodes.",
  call: "Stop selling it as a call first.",
  course: "Stop selling it as a course first.",
  bundle: "A bundle cannot be a podcast.",
  unknown: "That product is no longer in your store. Reload the page.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** Turning a product into a private podcast, and the way to its episodes once it is one. */
export function PodcastToggle({ product }: { product: Product }) {
  const studioHref = useStudioHref();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = product.priceCents > 0 && product.options.length === 0 && !product.file && !product.link && !product.call && !product.course && !product.bundle;

  if (product.podcast) {
    const n = product.podcast.episodes;
    return (
      <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
        <p className="text-sm font-semibold text-ink">{`Private podcast · ${n} ${n === 1 ? "episode" : "episodes"}`}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {n === 0 ? "Add the first episode and it can go on sale." : "Each buyer gets a feed of their own, for their own podcast app."}
        </p>
        <Link href={studioHref(`/studio/podcast/${product.id}`)} className="btn btn-primary btn-sm mt-3">
          {n === 0 ? "Add episodes" : "Edit the podcast"}
        </Link>
      </div>
    );
  }
  if (!eligible) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const response = await fetch("/api/store/podcast", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "enable", id: product.id }),
            });
            const data: unknown = await response.json().catch(() => null);
            const reply = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
            if (response.ok && reply?.ok === true && !("error" in reply) &&
                typeof reply.podcastId === "string" && /^[0-9a-f]{32}$/.test(reply.podcastId)) {
              router.push(studioHref(`/studio/podcast/${product.id}`));
              return;
            }
            const reason = reply?.ok !== true && typeof reply?.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : null;
            setError(reason ?? "We could not confirm this podcast setting. Reload this page to check before trying again.");
          } catch {
            setError("We could not confirm this podcast setting. Reload this page to check before trying again.");
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex min-h-11 items-center text-left text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
      >
        Sell this as a private podcast
      </button>
      {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
    </div>
  );
}
