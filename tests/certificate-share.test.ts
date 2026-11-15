/**
 * A certificate on LinkedIn (lib/certificate.ts, added 10 October 2026).
 * What is checked: the link to LinkedIn's "Add to Profile" form carries the
 * course as the certification, the creator as its issuer, the month it was
 * issued in, its ID and the page that proves it, all read from the record;
 * the link to a LinkedIn post carries the page; the words on both buttons
 * are in every store language; and the picture a shared link unfolds into
 * says only what the record says, and nothing for a certificate withdrawn
 * or expired (tests/certificate-card-standing.test.ts draws it).
 */
import { linkedInAddUrl, linkedInShareUrl } from "@/lib/certificate";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Added to a LinkedIn profile");
  const page = "https://marktmorgen.com/@harbor/certificate/abcdefgh12345678";
  const certificate = { id: "abcdefgh12345678", title: "Knife Skills & Sauces", creator: "Harbor Kitchen", issuedAt: Date.UTC(2026, 9, 10, 12) / 1000 };
  const add = new URL(linkedInAddUrl(certificate, page));
  is("LinkedIn's own form for a certification", [add.origin + add.pathname, add.searchParams.get("startTask")], ["https://www.linkedin.com/profile/add", "CERTIFICATION_NAME"]);
  is(
    "filled in from the record: the course, who issued it, when, its ID and the page that proves it",
    ["name", "organizationName", "issueYear", "issueMonth", "certId", "certUrl"].map((key) => add.searchParams.get(key)),
    ["Knife Skills & Sauces", "Harbor Kitchen", "2026", "10", "abcdefgh12345678", page],
  );
  const share = new URL(linkedInShareUrl(page));
  is("and a post about the page, on LinkedIn's own page", [share.origin + share.pathname, share.searchParams.get("url")], ["https://www.linkedin.com/sharing/share-offsite/", page]);

  part("In every store language");
  const words = LANGUAGE_CODES.map((code) => coursesWords(code));
  is("both buttons, each language its own words, each naming LinkedIn", [new Set(words.map((w) => w.addToLinkedIn)).size, new Set(words.map((w) => w.shareOnLinkedIn)).size, words.every((w) => w.addToLinkedIn.includes("LinkedIn") && w.shareOnLinkedIn.includes("LinkedIn"))], [LANGUAGE_CODES.length, LANGUAGE_CODES.length, true]);

  part("The picture a shared link unfolds into");
  const card = readFileSync("app/[handle]/certificate/[id]/opengraph-image.tsx", "utf8");
  is("drawn only for a certificate of that store that still stands, neither withdrawn nor expired", /found\.store === storeKey\(store\) && standingOf\(found, [^)]+\)\) === "valid"/.test(card), true);
  is("from the record's own name, course and teacher", ["certificate.name", "certificate.title", "certificate.creator"].every((field) => card.includes(field)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
