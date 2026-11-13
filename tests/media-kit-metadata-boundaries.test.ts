import { generateMetadata } from "@/app/[handle]/media-kit/page";
import { wordsIn } from "@/lib/buyer-words";
import { kitWords } from "@/lib/buyer-words/kit";
import { SITE_URL } from "@/lib/site-url";
import { claimHandle, noteTakedown, setKit, setLanguage } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const metadata = (handle: string) => generateMetadata({ params: Promise.resolve({ handle }) });
const fallback = { title: "Not found — Marktmorgen", robots: { index: false, follow: false } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "kit-boundaries@example.test";
  const handle = "kit-boundaries";
  const name = "Sample media kit";
  await claimHandle(owner, handle, name, "");
  await setLanguage(owner, "fr");

  part("Unavailable metadata contains no published-kit description or canonical");
  is("active hidden kit has only localized title and no-index/no-follow", await metadata(`@${handle}`), {
    title: `${wordsIn("fr").missingTitle} — ${name}`,
    robots: { index: false, follow: false },
  });
  is("an absent store has only the general title and robots", await metadata("@no-such-kit-boundaries"), fallback);
  is("a handle without @ does not disclose a known store", await metadata(handle), fallback);

  part("Suspension takes precedence over kit visibility and encoded handles");
  await noteTakedown(owner, null, true);
  is("suspended hidden kit does not disclose its store name", await metadata(`@${handle}`), fallback);
  is("encoded uppercase suspended handle remains private", await metadata("%40KIT-BOUNDARIES"), fallback);
  await setKit(owner, { on: true, pitch: "A public sample kit." }, "2026-11-07");
  is("suspended published kit also has only general metadata", await metadata(`@${handle}`), fallback);

  part("Restoring the store restores the published metadata");
  await noteTakedown(owner, null, false);
  is("active published kit keeps title, description and canonical", await metadata(`@${handle}`), {
    title: `${name}: ${kitWords("fr").title}`,
    description: "A public sample kit.",
    alternates: { canonical: `${SITE_URL}/@${handle}/media-kit` },
  });
  done();
}

void main();
