/**
 * A reminder queue member is read only in the exact shape reminderMember writes (Claude 7, 13 November 2026):
 * five fields, the start a whole number of milliseconds. A blank start read as 0, a negative one or an extra field
 * was taken for a member before.
 */
import { done, is, part } from "./check";
import { parseMember, reminderMember } from "@/lib/call-records";

part("parseMember reads back what reminderMember writes");
{
  const member = reminderMember("c1", "shop", "cs_test_1", "24", 1_800_000_000_000);
  is("a written member reads back", parseMember(member), { callsId: "c1", handle: "shop", session: "cs_test_1", mark: "24", start: 1_800_000_000_000 });
}

part("parseMember refuses an ill-shaped member");
for (const bad of ["c1|shop|cs_x|24|", "c1|shop|cs_x|24| ", "c1|shop|cs_x|24|-5", "c1|shop|cs_x|24|123|junk", "c1|shop|cs_x|24|1e3", "c1|shop|cs_x|24|0x10", "c1|shop|cs_x|24|1.5"]) {
  is(`${JSON.stringify(bad)} is refused`, parseMember(bad), null);
}

done();
