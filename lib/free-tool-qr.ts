/**
 * 244 [SP1], unit 2: the QR code tool's rules (components/free-tool-qr.tsx), apart from lib/free-tools.ts so the
 * QR encoder ships only with the page that uses it. Pure and browser-safe: no request, nothing kept.
 */
import QRCode from "qrcode";
import { qrFileName, qrSvg } from "@/lib/share-links";

/** The longest web address made into a code. */
export const MAX_QR_LINK = 1000;

/**
 * A web address typed by a visitor, as it will be encoded: http or https only (a bare domain gets https), no spaces,
 * a host with a dot, at most MAX_QR_LINK characters. Anything else (a script, data, mail or phone address, a bare
 * word, an empty field) is null.
 */
export function readLink(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_QR_LINK || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".") || url.username || url.password) return null;
  return url.href.length <= MAX_QR_LINK ? url.href : null;
}

/** The QR code for a web address, as an SVG drawing and a file name from the address; null when it is not one. */
export function qrForLink(raw: string): { link: string; svg: string; fileName: string } | null {
  const link = readLink(raw);
  if (!link) return null;
  const code = QRCode.create(link, { errorCorrectionLevel: "M" });
  const modules = Array.from(code.modules.data, Boolean);
  const url = new URL(link);
  return { link, svg: qrSvg(modules, code.modules.size), fileName: qrFileName(`${url.hostname}${url.pathname}`, "svg") };
}
