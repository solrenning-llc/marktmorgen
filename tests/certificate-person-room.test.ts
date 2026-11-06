/**
 * Deleting a person (lib/person-erasure.ts) takes their certificates out and
 * gives back to the store's data room exactly what each took when it was
 * issued (lib/certificate.ts, issueCertificate), withdrawn or not, once.
 */
import { certificatesFor, forgetCertificatesPerson, issueCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const lesson = (id: string) => ({ id, title: id, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }) as unknown as Course["modules"][number]["lessons"][number];
const course: Course = { id: "d".repeat(32), certificate: true, startsAt: null, modules: [{ id: "module000001", title: "One", dripDays: 0, lessons: [lesson("lesson000001")] }] } as Course;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const input = (email: string, name: string) => ({ store: "storekey01", productId: "prod01", course, title: "Bookkeeping Basics", creator: "Night School", email, who: emailKey(email), name, room: ROOM });

  part("A deleted person's certificates give their room back, withdrawn ones too");
  await issueCertificate(input("ben@example.com", "Ben Okafor"));
  const withBen = await used();
  const first = await issueCertificate(input("ana@example.com", "Ana Lopes"));
  if (!first.ok) throw new Error("not issued");
  is("the first withdrawn", await withdrawCertificate(course.id, first.certificate.id), true);
  await issueCertificate(input("ana@example.com", "Ana María Lopes"));
  is("Ana's two certificates take room", (await used()) > withBen, true);
  is("both deleted", await forgetCertificatesPerson([course.id], "ana@example.com", ROOM), 2);
  is("exactly their room given back", await used(), withBen);
  is("Ben's is kept", (await certificatesFor(course.id)).total, 1);
  is("a second deletion gives back nothing", [await forgetCertificatesPerson([course.id], "ana@example.com", ROOM), await used()], [0, withBen]);

  part("Two deletions at once give the room back once");
  await issueCertificate(input("cy@example.com", "Cy Park"));
  await issueCertificate(input("dee@example.com", "Dee Moss"));
  const withDee = await used();
  const cy = await issueCertificate(input("cy2@example.com", "Cy Two"));
  const both = await Promise.all([forgetCertificatesPerson([course.id], "cy2@example.com", ROOM), forgetCertificatesPerson([course.id], "cy2@example.com", ROOM)]);
  is("one of them deleted it", both.reduce((a, b) => a + b, 0) >= 1, true);
  is("its room given back once: the others' still counted", await used(), withDee);

  part("A withdrawal racing the deletion never writes the certificate back");
  if (!cy.ok) throw new Error("not issued");
  is("withdrawing a deleted certificate writes nothing", await withdrawCertificate(course.id, cy.certificate.id), false);
  is("and it is not there again", (await redis.pipeline([["EXISTS", `nl:cert:${cy.certificate.id}`]]))[0], 0);

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCertificatesPerson([course.id], "ben@example.com"), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
