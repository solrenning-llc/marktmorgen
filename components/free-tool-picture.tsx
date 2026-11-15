"use client";

/**
 * 244 [SP1], unit 3: a picture resized for a product page, in the visitor's
 * browser, with the studio's own shrinking (components/shrink-image.ts) to the
 * store's own size (lib/free-tool-picture.ts). The picture is opened, drawn and
 * saved on this device only: nothing is uploaded, sent or kept.
 */
import { useEffect, useId, useState } from "react";
import { shrink } from "@/components/shrink-image";
import { PICTURE_ACCEPT, PICTURE_LONG_SIDE, PICTURE_MAX_BYTES, PICTURE_MAX_SOURCE_BYTES, pictureFileName, sizeInWords, sourceProblem } from "@/lib/free-tool-picture";

type Made = { url: string; name: string; width: number; height: number; bytes: number };

export function PictureTool() {
  const help = useId();
  const [made, setMade] = useState<Made | null>(null);
  const [problem, setProblem] = useState("");
  const [working, setWorking] = useState(false);

  // The previous result's object address is let go when a new one replaces it, and when the page closes.
  useEffect(() => () => { if (made) URL.revokeObjectURL(made.url); }, [made]);

  async function choose(file: File | undefined) {
    setProblem("");
    setMade(null);
    if (!file) return;
    const why = sourceProblem(file);
    if (why) {
      setProblem(
        why === "type"
          ? "Choose a JPEG, PNG or WebP picture."
          : why === "size"
            ? `That file is over ${sizeInWords(PICTURE_MAX_SOURCE_BYTES)}. Choose a smaller one.`
            : "That file is empty. Choose another picture.",
      );
      return;
    }
    setWorking(true);
    try {
      const out = await shrink(file, PICTURE_LONG_SIDE, PICTURE_MAX_BYTES);
      setMade({ url: URL.createObjectURL(out.blob), name: pictureFileName(file.name, out.width, out.height, out.blob.type), width: out.width, height: out.height, bytes: out.blob.size });
    } catch {
      setProblem("This picture could not be opened or made small enough here. Try another one.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-6">
      <p id={help} className="max-w-[70ch]">
        {`The picture is made at most ${PICTURE_LONG_SIDE.toLocaleString("en-US")} pixels on its long side and at most ${sizeInWords(PICTURE_MAX_BYTES)}, the size a Marktmorgen store keeps a product picture at. It keeps its shape. Your picture never leaves your device.`}
      </p>
      <form className="max-w-xl" onSubmit={(e) => e.preventDefault()} noValidate>
        <label htmlFor="picture-file" className="field-label">Picture</label>
        <input
          id="picture-file"
          type="file"
          accept={PICTURE_ACCEPT}
          aria-describedby={help}
          disabled={working}
          onChange={(e) => void choose(e.target.files?.[0])}
          className="field mt-2 w-full"
        />
      </form>
      {problem ? (
        <p className="notice notice-warn max-w-xl text-ink" aria-live="polite">{problem}</p>
      ) : null}
      <output aria-live="polite" htmlFor="picture-file" className="block max-w-xl">
        {working ? (
          <span>Resizing…</span>
        ) : made ? (
          <span className="grid justify-items-start gap-4">
            <span>{`Done: ${made.width.toLocaleString("en-US")} by ${made.height.toLocaleString("en-US")} pixels, ${sizeInWords(made.bytes)}.`}</span>
            {/* eslint-disable-next-line @next/next/no-img-element -- a picture made on this device, not a file to optimize */}
            <img src={made.url} alt="Your resized picture" width={made.width} height={made.height} className="h-auto max-h-80 w-auto max-w-full rounded-xl ring-1 ring-line" />
            <a href={made.url} download={made.name} className="btn btn-secondary">Save the resized picture</a>
          </span>
        ) : (
          <span>Choose a picture to resize it.</span>
        )}
      </output>
    </div>
  );
}
