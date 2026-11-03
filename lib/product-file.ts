/**
 * The file a creator sells: where it lives, how big it may be, and what it
 * may be.
 *
 * Files are held in a private Blob store. A private blob has a URL, but that
 * URL answers nothing without a token, so a link that leaks is worth nothing
 * and the file can only ever leave through a route of ours that checked who
 * is asking. That is the whole reason the store is private rather than public:
 * a public blob URL is a permanent key to the product, and the first person
 * who shares it has given the product away.
 */

import { ownsVaultPath } from "./vault-rules";

/**
 * The biggest file a store may hold, and why this number.
 *
 * Five gigabytes, which is what Stan says it supports, so a creator choosing
 * between the two is never choosing on this. It used to be fifty megabytes,
 * set when nothing could be delivered without passing through a function and
 * a big file therefore could not be delivered at all.
 *
 * It is still a money ceiling as much as a technical one. Storage is cheap
 * — pennies per gigabyte per month — but delivery is not, so what actually
 * bounds the bill is how much is sent in a month rather than how big any one
 * file is. That allowance is the thing to publish and enforce.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Above this, the browser uploads in parts rather than in one request.
 *
 * A single request carrying a gigabyte is one dropped connection away from
 * starting again from nothing. In parts, only the failed part repeats.
 */
export const MULTIPART_ABOVE_BYTES = 20 * 1024 * 1024;

/**
 * Above this, a paid download is a redirect rather than a stream.
 *
 * Streaming through our own function lets us set the saved file name and
 * force a download, which is nicer, so small files still go that way. But
 * every byte then counts twice — data transfer out of storage and origin
 * transfer out of the function — and the function has a time limit a large
 * file on a slow line will pass. Above this size the buyer is redirected to
 * a signed URL that expires in minutes, the bytes go straight from storage,
 * and the download cannot time out.
 */
export const REDIRECT_ABOVE_BYTES = 20 * 1024 * 1024;

/** How long a signed download URL stays good. Long enough to start, no more. */
export const DOWNLOAD_URL_SECONDS = 5 * 60;

/**
 * The biggest PDF that is stamped with its buyer's email (lib/pdf-stamp.ts).
 *
 * Stamping reads the whole file into memory, marks every page and writes it
 * out again, inside one function with a time limit. Fifty megabytes is a
 * 500-page illustrated book; above it the time and memory a stamp takes stop
 * being predictable, so a bigger PDF is handed over as it was uploaded and
 * the studio tells the creator so, beside the setting.
 */
export const MAX_STAMP_BYTES = 50 * 1024 * 1024;

/** Whether a stored file is a PDF, by the type storage measured when it arrived. */
export function isPdf(file: Pick<ProductFile, "contentType" | "name">): boolean {
  return file.contentType === "application/pdf" || (!file.contentType && /\.pdf$/i.test(file.name));
}

/** Whether a stored file is an EPUB book, by the type storage measured when it arrived (630 [HN6](30)). */
export function isEpub(file: Pick<ProductFile, "contentType" | "name">): boolean {
  return file.contentType === "application/epub+zip" || (!file.contentType && /\.epub$/i.test(file.name));
}

/**
 * Whether a product's marking switch applies to a file: a PDF gets the line on
 * every page (lib/pdf-stamp.ts), an EPUB the same line inside the book where
 * reading apps do not show it (lib/epub-stamp.ts).
 */
export function isMarkable(file: Pick<ProductFile, "contentType" | "name">): boolean {
  return isPdf(file) || isEpub(file);
}

/**
 * What a creator may sell.
 *
 * Documents, pictures, sound, video and archives. Anything that runs — an
 * installer, a script, a program — is refused, because a store that hands out
 * executables is a store that hands out malware the day someone takes an
 * account over, and no creator here has asked to sell one.
 */
export const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/epub+zip": ".epub",
  "application/zip": ".zip",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
};

/** The list for the file picker, so the creator sees only what will be taken. */
export const ACCEPT_ATTRIBUTE = Object.values(ALLOWED_TYPES).join(",");

export const ALLOWED_CONTENT_TYPES = Object.keys(ALLOWED_TYPES);

/** One file on one product. */
export type ProductFile = {
  /** Where it sits in the private store. The only handle we keep. */
  pathname: string;
  /** What the creator called it. What the buyer will see it saved as. */
  name: string;
  bytes: number;
  contentType: string;
  addedAt: string;
};

/**
 * Whatever came back from storage, made safe to use.
 *
 * Lives here rather than beside the store record because a file hangs on a
 * product and on a price option alike, and both read it back the same way.
 */
export function parseProductFile(raw: unknown): ProductFile | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ProductFile>;
  if (typeof value.pathname !== "string" || !value.pathname) return null;
  if (typeof value.name !== "string" || !value.name) return null;
  if (typeof value.bytes !== "number" || !Number.isFinite(value.bytes)) {
    return null;
  }
  return {
    pathname: value.pathname,
    name: value.name,
    bytes: value.bytes,
    contentType: typeof value.contentType === "string" ? value.contentType : "",
    addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
  };
}

/**
 * The folder that belongs to one store and one product.
 *
 * Every upload is forced under this prefix, and every file we read back is
 * checked against it. Two creators therefore cannot reach each other's files
 * even if one of them sends us a pathname by hand: the folder is derived from
 * their own account, never from anything they typed.
 */
export function fileFolder(storeFolder: string, productId: string): string {
  return `stores/${storeFolder}/${productId}/`;
}

/**
 * Whether a pathname really is this store's and this product's, in either of
 * the two stores a sold file may be kept in (lib/file-store.ts).
 */
export function ownsPath(
  pathname: string,
  storeFolder: string,
  productId: string,
): boolean {
  if (typeof pathname !== "string") return false;
  if (ownsVaultPath(pathname, storeFolder, productId)) return true;
  if (pathname.includes("..") || pathname.includes("//")) return false;
  const prefix = fileFolder(storeFolder, productId);
  if (!pathname.startsWith(prefix)) return false;
  // Nothing after the folder may open another folder.
  return !pathname.slice(prefix.length).includes("/");
}

/** A size a person reads: 1.4 GB, 2.4 MB, 812 KB. */
export function readableSize(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  // "5 GB" rather than "5.0 GB": a round number reads as a limit, and a
  // limit with a decimal on it reads as a measurement of something.
  if (bytes >= gb) {
    const size = (bytes / gb).toFixed(1).replace(/\.0$/, "");
    return `${size} GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** The limit, said the way the pages say it. */
export function maxFileLabel(): string {
  return readableSize(MAX_FILE_BYTES);
}

/** Keeps a file name that is safe to put in a header and to save to a disk. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f"\\]/g, "").trim();
  return cleaned.slice(0, 120) || "file";
}

/** The PDF a product's page can be written from (lib/ai.ts, readPdfFacts): its own file, or else its first option's, when a PDF small enough to read. */
export function readableFile(product: { file: ProductFile | null; options: { file?: ProductFile | null }[] }): ProductFile | null {
  const candidates = [product.file, ...product.options.map((o) => o.file ?? null)];
  return candidates.find((f): f is ProductFile => Boolean(f && isPdf(f) && f.bytes <= MAX_STAMP_BYTES)) ?? null;
}
