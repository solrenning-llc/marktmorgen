/**
 * Stored lesson comments are evidence (CX-123 rule 24): a malformed time,
 * parent, name, or visibility never becomes a known public thread. Legacy
 * records may omit the optional display name, parent, and hidden flag.
 */
import { parseComment, threadsFor } from "@/lib/lesson-comments-rules";
import { done, is, part } from "./check";

const base = {
  id: "top000000001",
  l: "lesson000001",
  b: "student-one",
  n: "Ada",
  t: "Where should the dough rest?",
  a: 100,
  r: null,
};

const read = (value: Record<string, unknown>) => parseComment(JSON.stringify(value));

part("Known records retain their exact meaning");
is("a current public comment", read(base), {
  id: base.id,
  lesson: base.l,
  by: base.b,
  name: base.n,
  text: base.t,
  at: base.a,
  parent: null,
  hidden: false,
});
is("a current hidden reply", read({ ...base, id: "reply0000001", r: base.id, h: true })?.parent, base.id);
const { n: _name, r: _parent, ...legacy } = base;
void _name;
void _parent;
is("legacy optional fields remain absent defaults", read(legacy), {
  id: base.id,
  lesson: base.l,
  by: base.b,
  name: "",
  text: base.t,
  at: base.a,
  parent: null,
  hidden: false,
});

part("Malformed stored fields refuse the whole record");
const cases: [string, Record<string, unknown>][] = [
  ["missing time", Object.fromEntries(Object.entries(base).filter(([key]) => key !== "a"))],
  ["text time", { ...base, a: "100" }],
  ["fractional time", { ...base, a: 1.5 }],
  ["negative time", { ...base, a: -1 }],
  ["unsafe time", { ...base, a: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid parent", { ...base, r: "not-a-comment" }],
  ["non-text parent", { ...base, r: 42 }],
  ["non-text name", { ...base, n: 42 }],
  ["non-boolean visibility", { ...base, h: "true" }],
];
for (const [label, value] of cases) is(label, read(value), null);

part("Corruption cannot promote or disclose a thread");
const promoted = read({ ...base, id: "reply0000001", r: "broken-parent" });
is("a reply with an unreadable parent is not a top-level thread", promoted ? threadsFor([promoted], "another-student") : [], []);
const disclosed = read({ ...base, h: "true" });
is("an unreadable hidden flag is not shown as public", disclosed ? threadsFor([disclosed], "another-student") : [], []);

done();
