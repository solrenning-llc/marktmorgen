/**
 * Where the Proxy check comes from (Revisor 1 on #2822): Node's own isProxy when it can be read; none in a browser,
 * where no Redis reply arrives; and on a server without it, every reply counts as a Proxy, so reads fail closed as
 * unknown instead of quietly accepting a reply whose traps would run.
 */
import { types } from "node:util";
import { proxyCheckFor } from "@/lib/redis-reply";
import { done, is, part } from "./check";

const proxy = new Proxy(["a"], {});
const plain = ["a"];
const node = { getBuiltinModule: (id: string) => (id === "node:util" ? { types } : undefined) };

part("Node's own check, when it can be read");
const real = proxyCheckFor(node, false);
is("a Proxy is a Proxy", real(proxy), true);
is("a plain list is not", real(plain), false);

part("A browser: no Redis reply there, no check needed");
is("nothing counts as a Proxy", proxyCheckFor(undefined, true)(proxy), false);

part("A server without it: fail closed");
const errors: unknown[] = [];
const original = console.error;
console.error = (...args: unknown[]) => void errors.push(args);
try {
  const closed = proxyCheckFor({}, false);
  is("a plain list counts as a Proxy, so the read is unknown", closed(plain), true);
  is("and again", closed(proxy), true);
  is("said once, not on every read", errors.length, 1);
  is("no getBuiltinModule at all, same", proxyCheckFor(undefined, false)(plain), true);
} finally {
  console.error = original;
}
done();
