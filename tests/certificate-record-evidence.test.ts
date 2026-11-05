/** Stored validity evidence must not be silently turned into a standing certificate. */
import { allKey, certificateOf, certificatesOf, certKey, forgetCertificatesPerson, readCertificate, standingOf } from "@/lib/certificate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const id = "evidencecert0001";
const base = { id, store: "evidence-store", courseId: "c".repeat(32), productId: "course1", name: "Sample Student", title: "Sample Course", creator: "Sample School", email: "student@example.com", issuedAt: 1_790_000_000, withdrawnAt: 0 };
async function put(change: Record<string, unknown>, omit?: string) {
  const record: Record<string, unknown> = { ...base, ...change };
  if (omit) delete record[omit];
  await redis.pipeline([["SET", certKey(id), JSON.stringify(record)]]);
  return readCertificate(id);
}

async function main() {
  redis.clear();
  part("Explicit expiration evidence");
  for (const bad of [null, "1800000000", false, 0, -1, 1.5, 8_640_000_000_001, {}, []]) {
    is(`expiration ${JSON.stringify(bad)} is unknown, never permanent`, await put({ validUntil: bad }), null);
  }
  part("Withdrawal and issue evidence");
  for (const field of ["withdrawnAt", "issuedAt"]) {
    for (const bad of [null, "1790000000", false, -1, 1.5, 8_640_000_000_001]) {
      is(`${field} ${JSON.stringify(bad)} is unknown, never standing`, await put({ [field]: bad }), null);
    }
    is(`${field} absent is not evidence`, await put({}, field), null);
  }
  part("Known legacy and current records");
  const legacy = await put({});
  is("a legacy record without expiration stays permanent", legacy && [legacy.issuedAt, legacy.withdrawnAt, Object.hasOwn(legacy, "validUntil"), standingOf(legacy, 1_900_000_000)], [base.issuedAt, 0, false, "valid"]);
  const expired = await put({ validUntil: 1_800_000_000 });
  is("known expiration stays expired", expired && standingOf(expired, 1_800_000_001), "expired");
  const withdrawn = await put({ withdrawnAt: 1_795_000_000, validUntil: 1_800_000_000 });
  is("known withdrawal stays withdrawn", withdrawn && standingOf(withdrawn, 1_796_000_000), "withdrawn");
  await put({ validUntil: "1800000000" });
  await redis.pipeline([["HSET", `nl:course:${base.courseId}:certs`, "student", id]]);
  is("the student's real certificate lookup never returns malformed evidence", await certificateOf(base.courseId, "student"), null);
  part("Privacy rights do not depend on a certificate standing");
  redis.clear();
  const malformed = { ...base, validUntil: "1800000000", withdrawnAt: null };
  const otherId = "otherstudent0001";
  await redis.pipeline([["SET", certKey(id), JSON.stringify(malformed)], ["SET", certKey(otherId), JSON.stringify({ ...malformed, id: otherId, email: "other@example.com" })], ["SADD", allKey(base.courseId), id, otherId]]);
  const entries = (value: object) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  is("legacy privacy export includes malformed evidence exactly as stored", (await certificatesOf([base.courseId], base.email)).map(entries), [entries(malformed)]);
  is("legacy erasure still finds a record with malformed status by its own email", await forgetCertificatesPerson([base.courseId], base.email), 1);
  is("the erased record is gone and another student's record stays", await redis.pipeline([["GET", certKey(id)], ["EXISTS", certKey(otherId)]]), [null, 1]);
  done();
}
void main();
