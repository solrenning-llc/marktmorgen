/**
 * The real lib/picture-r2.ts with the pictures' bucket switched on or off by the test (tests/r2-mirror-delete.test.ts):
 * on main it stays off until the owner records PICTURE_R2_CEILING, so no test could reach a mirror otherwise.
 * Synthetic settings only.
 */
import type { PictureR2Config } from "../lib/picture-r2";
export * from "../lib/picture-r2";

let on = true;
export function setMirrorOn(value: boolean): void {
  on = value;
}
export function pictureR2Config(): PictureR2Config | null {
  if (!on) return null;
  return {
    endpoint: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    bucket: "synthetic-pictures",
    origin: "https://images.example.net",
    key: { accessKeyId: "SYNTHETICKEYID0001", secretAccessKey: "synthetic-secret-key-only-for-this-test-0001" },
  };
}
