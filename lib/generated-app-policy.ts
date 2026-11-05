/**
 * Where code an AI generates for a store runs, and what it may reach: 631
 * [AA1] (d), unit 7 (owner, 2 November 2026, 02h15 Fortaleza). The owner's
 * text: "o código roda isolado num domínio próprio de aplicativos, separado
 * do estúdio, do checkout e dos dados de compradores, com política de
 * segurança de conteúdo restrita, sem acesso a segredos, sessões ou dados
 * pessoais".
 *
 * This file is that first wall as rules, pure and tested, before anything is
 * served (lib/generated-code-check.ts is the second wall, which reads the
 * code itself). What it decides:
 *
 *   - The apps domain must be another site, not a subdomain of this one:
 *     a page on apps.marktmorgen.com would be "same site" as the studio,
 *     so a creator's session cookie (SameSite=Lax) could ride along with
 *     what it starts. `separateSite` refuses that. Choosing and paying for
 *     that domain is the owner's (it is a purchase), so nothing is served
 *     until it exists.
 *   - Every app document gets a Content-Security-Policy with `sandbox
 *     allow-scripts` and no `allow-same-origin`: the browser runs it as an
 *     origin of its own, with no cookies, no storage, no way to reach the
 *     page around it, open windows, navigate the top page or submit a form.
 *     Scripts only from the apps domain itself or by the hash of an inline
 *     script the creator approved; no eval; no frames, workers, plug-ins or
 *     <base>; pictures and media only from the store's own files; network
 *     only to the addresses given (none by default: an app's own narrow door
 *     to the store's data is a later unit, never a key in the page). Only the
 *     store's own pages may frame it.
 *   - Headers: no referrer, every powerful browser feature off, its own
 *     window group, nosniff.
 *   - The frame that shows it on a store page carries the same sandbox, no
 *     feature, no referrer, and a title, because a frame without one has no
 *     name for a screen reader (WCAG 4.1.2).
 */
import { createHash } from "node:crypto";

/** "https://host" or "https://host:port", nothing else: no path, no wildcard, no http. */
const ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;

export function isOrigin(value: string): boolean {
  return ORIGIN.test(value);
}

/** The last two labels of a host: enough for the .com, .app and other single-label endings this needs. */
const siteOf = (origin: string) => new URL(origin).hostname.split(".").slice(-2).join(".");

/** Whether two origins are different sites, so cookies of one are never "same site" for the other. */
export function separateSite(appsOrigin: string, platformOrigin: string): boolean {
  if (!isOrigin(appsOrigin) || !isOrigin(platformOrigin)) return false;
  return siteOf(appsOrigin) !== siteOf(platformOrigin);
}

/** The CSP source for an inline script, by its exact text. */
export function scriptHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export type AppPolicyInput = {
  /** The store pages that may show the app: this site and the creator's own domain. */
  framedBy: readonly string[];
  /** Where pictures and media may come from: the store's own files. */
  filesFrom?: readonly string[];
  /** Where the app may send and read data; none by default. */
  connectTo?: readonly string[];
  /** The exact text of each inline script the creator approved. */
  inlineScripts?: readonly string[];
};

export type AppPolicyRefusal = "no_frame" | "bad_origin";

const POWERFUL =
  "accelerometer=(), ambient-light-sensor=(), autoplay=(), bluetooth=(), browsing-topics=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), hid=(), identity-credentials-get=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), otp-credentials=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), storage-access=(), usb=(), web-share=(), window-management=(), xr-spatial-tracking=()";

/** The Content-Security-Policy of an app document, or why it cannot be made. */
export function appPolicy(input: AppPolicyInput): { ok: true; policy: string } | { ok: false; error: AppPolicyRefusal } {
  const framedBy = [...new Set(input.framedBy)];
  const filesFrom = [...new Set(input.filesFrom ?? [])];
  const connectTo = [...new Set(input.connectTo ?? [])];
  if (!framedBy.length) return { ok: false, error: "no_frame" };
  if (![...framedBy, ...filesFrom, ...connectTo].every(isOrigin)) return { ok: false, error: "bad_origin" };
  const hashes = [...new Set((input.inlineScripts ?? []).map(scriptHash))];
  const directives: [string, string[]][] = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'", ...hashes]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", ...filesFrom]],
    ["media-src", ["'self'", ...filesFrom]],
    ["font-src", ["'self'"]],
    ["connect-src", connectTo.length ? connectTo : ["'none'"]],
    ["frame-src", ["'none'"]],
    ["child-src", ["'none'"]],
    ["worker-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["manifest-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", framedBy],
    ["sandbox", ["allow-scripts"]],
  ];
  return { ok: true, policy: directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ") };
}

/** Every header an app document is served with, beside its policy. */
export function appHeaders(policy: string): Record<string, string> {
  return {
    "Content-Security-Policy": policy,
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": POWERFUL,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-cache",
  };
}

/** The attributes of the frame a store page shows an app in, or null when they cannot be safe. */
export function appFrameAttributes(input: { src: string; appsOrigin: string; title: string }): Record<string, string> | null {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title || !isOrigin(input.appsOrigin)) return null;
  let src: URL;
  try {
    src = new URL(input.src);
  } catch {
    return null;
  }
  if (src.origin !== input.appsOrigin || src.username || src.password) return null;
  return {
    src: src.href,
    title: title.slice(0, 120),
    sandbox: "allow-scripts",
    allow: "",
    referrerpolicy: "no-referrer",
    loading: "lazy",
  };
}
