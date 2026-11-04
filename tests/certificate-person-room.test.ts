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

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCertificatesPerson([course.id], "ben@example.com"), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
