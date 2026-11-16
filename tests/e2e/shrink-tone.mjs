/**
 * Encanto 5b-1, the picture's color, in a real browser (Codex K2 on #2790, review 5799195602): the real
 * components/shrink-image.ts, bundled for the browser, shrinks four synthetic pictures (opaque, one transparent pixel,
 * a transparent stripe, and the same opaque one written as JPEG); each picture it gives back is decoded pixel by pixel,
 * and the color it reports must be null wherever the decoded picture has any transparency, and a color wherever it
 * has none. That holds in every engine: one that cannot write WebP gives a JPEG with white behind, which is opaque.
 * Nothing leaves the page: every network request (http or https) is refused and counted. Only those are routed: WebKit
 * sends a blob: URL through request interception too (playwright-core wkPage _onRequestWillBeSent skips only data: and
 * about:), so a route on every URL aborted the picture's own blob: load and image.decode() failed with "EncodingError:
 * Loading error" (WebKit job 127901687708 on #2790). A blob: or data: URL never leaves the page.
 */
import { join } from "node:path";
import { build } from "esbuild";

export async function checkShrinkTone({ browser, root, is, source = join(root, "components/shrink-image.ts") }) {
  const bundle = await build({ entryPoints: [source], bundle: true, platform: "browser", format: "iife", globalName: "MMShrink", alias: { "@": root }, write: false, logLevel: "error" });
  const context = await browser.newContext();
  let requests = 0;
  await context.route((url) => url.protocol === "http:" || url.protocol === "https:", (route) => {
    requests += 1;
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.setContent("<!doctype html><title>shrink</title>");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const seen = await page.evaluate(async () => {
      const results = [];
      for (const kind of ["opaque", "one transparent pixel", "transparent stripe", "jpeg"]) {
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 1024;
        const context = canvas.getContext("2d");
        context.fillStyle = "#336699";
        context.fillRect(0, 0, 1024, 1024);
        if (kind === "one transparent pixel") context.clearRect(511, 511, 1, 1);
        if (kind === "transparent stripe") context.clearRect(0, 0, 64, 1024);
        const png = await new Promise((done) => canvas.toBlob(done, "image/png"));
        const shrunk = await globalThis.MMShrink.shrink(new File([png], "synthetic.png", { type: "image/png" }), 1600, 1_000_000, kind === "jpeg");
        const bitmap = await createImageBitmap(shrunk.blob);
        const decoded = document.createElement("canvas");
        decoded.width = bitmap.width;
        decoded.height = bitmap.height;
        const target = decoded.getContext("2d");
        target.drawImage(bitmap, 0, 0);
        const pixels = target.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let transparent = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) transparent += 1;
        bitmap.close();
        results.push({ kind, type: shrunk.blob.type, tone: shrunk.tone, transparent });
      }
      return results;
    });
    for (const item of seen) {
      const right = item.transparent > 0 ? item.tone === null : typeof item.tone === "string" && /^#[0-9a-f]{6}$/.test(item.tone);
      is(`shrink's color, ${item.kind} (${item.type}, ${item.transparent} transparent): none with any transparency, exact otherwise`, right, true);
    }
    is("shrink's color: every case read", seen.length, 4);
    is("shrink's color: nothing left the page", requests, 0);
  } finally {
    await context.close();
  }
}
