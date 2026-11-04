"use client";

import { useEffect } from "react";
import { sendRead, useStoreHandle } from "@/components/page-depth";

/**
 * On the store's own page, for one visitor in READ_SAMPLE, drawn by the
 * server, which hands only them a token (lib/page-read.ts): the furthest item they saw — a product, a link,
 * a part such as the sign-up box — where it stood, and the item they clicked,
 * if any. Sent once, when they leave the page or switch away from it, which
 * is also what opening a link in a new tab does. Nothing about the visitor:
 * no cookie, no time, only which items.
 */
export function StoreReach({ token }: { token: string }) {
  const handle = useStoreHandle();
  useEffect(() => {
    if (!token || !handle) return;
    if (typeof IntersectionObserver === "undefined") return;
    const items = [...document.querySelectorAll<HTMLElement>("[data-item]")];
    if (items.length === 0) return;
    let furthest = -1;
    let clicked = "";
    let sent = false;
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const at = items.indexOf(entry.target as HTMLElement);
          if (at > furthest) furthest = at;
        }
      },
      { threshold: 0.4 },
    );
    items.forEach((item) => watch.observe(item));
    const onClick = (event: MouseEvent) => {
      if (clicked || !(event.target instanceof Element)) return;
      // A press on something that goes somewhere or does something, inside an item.
      if (!event.target.closest("a[href], button")) return;
      const item = event.target.closest<HTMLElement>("[data-item]");
      if (item?.dataset.item) clicked = item.dataset.item;
    };
    const send = () => {
      if (sent) return;
      // Somebody who clicked an item saw it, even if it never stood 40% in view.
      const at = Math.max(furthest, clicked ? items.findIndex((item) => item.dataset.item === clicked) : -1);
      if (at < 0) return;
      sent = true;
      sendRead({ t: token, h: handle, k: "s", n: at, b: items[at].dataset.item ?? "", c: clicked });
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", send);
    return () => {
      watch.disconnect();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", send);
    };
  }, [token, handle]);
  return null;
}
