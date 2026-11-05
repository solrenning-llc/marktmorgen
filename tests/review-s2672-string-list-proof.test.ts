import { stringList } from "@/lib/redis-reply";
import { done, is } from "./check";

is("confirmed plain strings", stringList(["a", "b"]), ["a", "b"]);
is("confirmed empty list", stringList([]), []);
is("confirmed frozen list", stringList(Object.freeze(["a"])), ["a"]);
is("a plain hole is refused", stringList([, "b"]), null);

const inherited = [, "b"];
const prototype = Object.create(Array.prototype);
Object.defineProperty(prototype, "0", { value: "inherited" });
Object.setPrototypeOf(inherited, prototype);
is("a string inherited into a hole is not a confirmed member", stringList(inherited) === null, true);

let reads = 0;
const accessor = ["a"];
Object.defineProperty(accessor, "0", { get() { reads += 1; return "a"; } });
const result = stringList(accessor);
is("an accessor is refused without executing it", [result === null, reads], [true, 0]);
done();
