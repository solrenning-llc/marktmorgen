/** RED stub (758 [STN5] unit 3): the plan, the parts and the save are written in the next commit. */
import type { AiResult, AiStepsRun, AiStopped } from "@/lib/ai";
import type { FileDraft, FileOutline } from "@/lib/ai-file-rules";
import type { Listing } from "@/lib/catalog";
import type { ProductFile } from "@/lib/product-file";
import type { Store } from "@/lib/store";

export function fileTargetProblem(_product: Listing | null): "unknown" | "published" | "has_file" | "kind" | null {
  return null;
}
export function outlineRequest(_store: Store, _input: { productTitle: string; notes: string }): { system: string; prompt: string } | null {
  return null;
}
export function sectionRequests(_store: Store, _input: { productTitle: string; outline: FileOutline; notes: string }): { system: string; prompts: string[] } | null {
  return null;
}
export async function writeFileOutline(_store: Store, _input: { productTitle: string; notes: string }): Promise<AiResult<FileOutline>> {
  return { ok: false, reason: "off" };
}
export async function writeFileSections(_store: Store, _input: { productTitle: string; outline: FileOutline; notes: string }, _steps: AiStepsRun): Promise<AiResult<FileDraft> | AiStopped> {
  return { ok: false, reason: "off" };
}
export async function grantFileSave(_store: Store, _run: string): Promise<boolean> {
  return false;
}
export async function takeFileSave(_store: Store, _run: string): Promise<boolean | null> {
  return null;
}
export type FileSaveIo = {
  folder: () => Promise<string>;
  reserveUpload: (bytes: number) => Promise<boolean>;
  reserveRoom: (folder: string, bytes: number) => Promise<string | null>;
  releaseRoom: (folder: string, id: string) => Promise<void>;
  write: (pathname: string, bytes: Uint8Array) => Promise<boolean>;
  measure: (pathname: string) => Promise<{ size: number; contentType: string }>;
  remove: (pathname: string) => Promise<void>;
  attach: (file: ProductFile | null) => Promise<{ ok: true; removed: ProductFile | null } | { ok: false; reason: string }>;
  rememberOwner: (folder: string) => Promise<void>;
};
export type FileSaveResult = { ok: true; file: ProductFile; pages: number } | { ok: false; error: string };
export async function saveAiFile(_store: Store, _productId: string, _draft: FileDraft, _io: FileSaveIo): Promise<FileSaveResult> {
  return { ok: false, error: "failed" };
}
