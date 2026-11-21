/**
 * Every font the stamp reads ships with the one route that stamps (Claude 1 cloud, MEDIUM on #3761). stampPdf draws
 * the buyer's line through loadFonts (lib/certificate-pdf.ts), which reads three files with Promise.all; Next.js does
 * not trace these reads on its own, which is why the certificate routes list ./lib/fonts/**\/* by hand. A file missing
 * from the function makes readFile reject: stampPdf throws, every PDF goes out unstamped and the creator is told it
 * was unreadable. Locally and in CI everything reads from disk, so only the config can hold this.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const config = readFileSync("next.config.ts", "utf8");
const loader = readFileSync("lib/certificate-pdf.ts", "utf8");
const read = [...loader.matchAll(/readFile\(join\(process\.cwd\(\), "(lib\/fonts\/[^"]+)"\)\)/g)].map((m) => m[1]);
const line = config.split("\n").find((l) => l.includes('"/api/store/download"')) ?? "";
const covered = (file: string) => line.includes("./lib/fonts/**/*") || line.includes(`./${file}`);
is("loadFonts reads its three fonts", read.length, 3);
is("each font loadFonts reads ships with /api/store/download", read.filter((f) => !covered(f)), []);
done();
