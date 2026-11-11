/**
 * CX-123 rule 24, lot L10b: the replies Upstash could give a SET NX, or the GET that reads it back, and the stand-in
 * never does, injected for one command at a time. A rule matches a pipeline by its first command; the command may run
 * first (the write landed and the reply was lost) or not at all (the write did not land), and something may be written
 * just before it (another request taking the key a moment earlier). Every command sent is recorded, so a test can see
 * whether the guarded action ran. Rules apply in the order given, so a read-back's rule never answers an earlier read.
 */
import { store as redis } from "./redis-stub";

export type Command = (string | number)[];
type Rule = {
  /**
   * Named `matches`, not `match`: a call `rule.match(command)` reads to CodeQL as String.prototype.match, so every
   * address a test stores ("https://meet.google.com/...") was reported as an unescaped hostname regular expression.
   */
  matches: (command: Command) => boolean;
  reply: (real: unknown[]) => unknown;
  /** Whether the command reaches the stand-in before the reply is replaced. */
  run: boolean;
  /** Written just before the command, as another request would. */
  before?: () => void;
};

const rules: Rule[] = [];
/** Every pipeline sent, in order. */
export const sent: Command[][] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  // Rules apply in the order they were given: a read-back's rule waits for its write's.
  if (!rules.length || commands[0] === undefined || !rules[0].matches(commands[0])) return real(commands);
  const rule = rules.shift()!;
  rule.before?.();
  const got = rule.run ? ((await real(commands)) as unknown[]) : [];
  return rule.reply(got);
}) as typeof redis.pipeline;

/** The next pipeline whose first command matches is answered with `reply` instead (once). */
export function answer(match: (command: Command) => boolean, reply: (real: unknown[]) => unknown, options: { run?: boolean; before?: () => void } = {}): void {
  rules.push({ matches: match, reply, run: options.run ?? true, before: options.before });
}

export function clearAnswers(): void {
  rules.length = 0;
  sent.length = 0;
}

/** Commands of one name sent since the last clear, whose key starts with `prefix`. */
export function count(name: string, prefix = ""): number {
  return sent.flat().filter((c) => c[0] === name && String(c[1] ?? "").startsWith(prefix)).length;
}

export const setNx = (prefix: string) => (c: Command) => c[0] === "SET" && String(c[1] ?? "").startsWith(prefix) && c.includes("NX");
export const getOf = (prefix: string) => (c: Command) => c[0] === "GET" && String(c[1] ?? "").startsWith(prefix);

/** The odd answers to a SET NX, each one reply in a shape that is neither "OK" nor nil. */
export const ODD: [string, (real: unknown[]) => unknown][] = [
  ["no value", () => [undefined]],
  ["QUEUED", () => ["QUEUED"]],
  ["no reply at all", () => []],
  ["a reply too many", () => ["OK", "OK"]],
  ["not a list", () => "OK"],
];

/** A pipeline that failed: the database did not answer, or answered with an error. */
export const THROWS = () => {
  throw new Error("the database did not answer");
};

/** A read-back that cannot say what the key holds. */
export const UNREADABLE: [string, (real: unknown[]) => unknown][] = [
  ["a failed read", THROWS],
  ["a short read", () => []],
  ["a number", () => [1]],
];
