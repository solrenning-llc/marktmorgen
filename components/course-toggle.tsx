"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Product } from "@/lib/store";
import { useStudioHref } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  free: "A course is sold. Give it a price first.",
  options: "Take the price options off first: a course has one price.",
  delivery: "Take the file or link off first: a course delivers its lessons.",
  call: "Stop selling it as a call first.",
  bundle: "A bundle cannot be a course. Stop it being a bundle first.",
  unknown: "That product is no longer in your store. Reload the page.",
  busy: "This course is being changed right now. Try again in a moment.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/**
 * Turning a product into a course, and the way to its lessons once it is one. `newComments` is null when the new
 * comments could not be counted: the line says so, never that there are none (rule 24).
 */
export function CourseToggle({ product, newComments = 0 }: { product: Product; newComments?: number | null }) {
  const studioHref = useStudioHref();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible =
    product.priceCents > 0 && product.options.length === 0 && !product.file && !product.link && !product.call;

  if (product.course) {
    const n = product.course.lessons;
    return (
      <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
        <p className="text-sm font-semibold text-ink">{`Course · ${n} ${n === 1 ? "lesson" : "lessons"}`}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {n === 0 ? "Add the first lesson and it can go on sale." : "Buyers open it with their email address, on any device, with no password."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link href={studioHref(`/studio/course/${product.id}`)} className="btn btn-primary btn-sm">
            {n === 0 ? "Add lessons" : "Edit the course"}
          </Link>
          {newComments === null ? (
            <Link href={`${studioHref(`/studio/course/${product.id}`)}#comments`} className="text-sm font-semibold text-violet-deep underline underline-offset-4">
              New comments could not be loaded. Open the course comments
            </Link>
          ) : newComments > 0 ? (
            <Link href={`${studioHref(`/studio/course/${product.id}`)}#comments`} className="text-sm font-semibold text-violet-deep underline underline-offset-4">
              {`${newComments} new ${newComments === 1 ? "comment" : "comments"} to read`}
            </Link>
          ) : null}
        </div>
      </div>
    );
  }
  if (!eligible) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-busy={busy} disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const response = await fetch("/api/store/course", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "enable", id: product.id }),
            });
            const data: unknown = await response.json().catch(() => null);
            const reply = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
            if (response.ok && reply?.ok === true && !("error" in reply) &&
                typeof reply.courseId === "string" && /^[0-9a-f]{32}$/.test(reply.courseId)) {
              router.push(studioHref(`/studio/course/${product.id}`));
              return;
            }
            const reason = reply?.ok !== true && typeof reply?.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : null;
            setError(reason ?? "We could not confirm this course setting. Reload this page to check before trying again.");
          } catch {
            setError("We could not confirm this course setting. Reload this page to check before trying again.");
          } finally {
            setBusy(false);
          }
        }}
        className="text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
      >
        Sell this as a course with lessons
      </button>
      {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
    </div>
  );
}
