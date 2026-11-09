/**
 * What each channel is called where a creator reads it: the studio's numbers,
 * the membership numbers and the emails about them. One list, so a channel
 * has one name everywhere.
 */
export const SOURCE_NAMES: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  x: "X",
  threads: "Threads",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
  reddit: "Reddit",
  linktree: "Linktree",
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  email: "Email",
  whatsapp: "WhatsApp",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  claude: "Claude",
  gemini: "Gemini",
  copilot: "Copilot",
  deepseek: "DeepSeek",
  grok: "Grok",
  qr: "QR code",
  affiliates: "Affiliates",
  device: "Shared from a phone",
  direct: "Direct, or an app that hides it",
};

/** Where a buyer brought over from another platform first came from, in the list's groups (lib/segments.ts). */
export const IMPORTED_CHANNEL = "imported";

/**
 * The name the map gives a source, or undefined: only the map's own entries, so a source a visitor typed, such as
 * "__proto__" or "constructor", is never taken for one (Codex J, #1952) and stays its own text.
 */
export function sourceName(source: string): string | undefined {
  return Object.hasOwn(SOURCE_NAMES, source) ? SOURCE_NAMES[source] : undefined;
}

/** A channel's name where money is concerned: "direct" there means nothing the store could name. */
export function channelName(source: string): string {
  if (source === "direct" || source === "") return "Direct or unknown";
  if (source === "unrecorded") return "Sold before channels were recorded";
  if (source === IMPORTED_CHANNEL) return "Brought over from another platform";
  return sourceName(source) ?? source;
}
