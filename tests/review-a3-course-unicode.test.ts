import { test } from "node:test";
import assert from "node:assert/strict";
import { COURSE_IMPORT_FORMAT, previewCourseImport } from "@/lib/course-import";

function preview(path: string, kind: "video" | "file") {
  return previewCourseImport(JSON.stringify({ format: COURSE_IMPORT_FORMAT, ownsContent: true,
    title: "Synthetic Unicode review", modules: [{ title: "Module", lessons: [{ title: "Lesson", text: "",
      video: kind === "video" ? path : null, files: kind === "file" ? [path] : [] }] }] }));
}

test("every isolated surrogate loses its identity in UTF-8 and refuses the entire preview", () => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  for (let code = 0xd800; code <= 0xdfff; code++) {
    const path = `assets/${String.fromCharCode(code)}.bin`;
    assert.notEqual(decoder.decode(encoder.encode(path)), path);
    for (const kind of ["video", "file"] as const) {
      const result = preview(path, kind);
      assert.equal(result.ok, false, `${kind}: U+${code.toString(16)}`);
      assert.equal(Object.hasOwn(result, "draft"), false);
      assert.equal(Object.hasOwn(result, "assets"), false);
    }
  }
});

test("every high and low surrogate can participate in an exact supported pair", () => {
  for (let offset = 0; offset < 1024; offset++) {
    for (const pair of [String.fromCharCode(0xd800 + offset, 0xdc00), String.fromCharCode(0xdbff, 0xdc00 + offset)]) {
      const path = `assets/${pair}.bin`;
      const result = preview(path, "file");
      assert.ok(result.ok);
      assert.deepEqual(result.assets, [path]);
      assert.deepEqual([result.storageBytes, result.videoSeconds, result.costUsd], [null, null, null]);
    }
  }
});
