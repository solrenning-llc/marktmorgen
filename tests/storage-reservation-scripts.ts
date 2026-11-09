/**
 * The two scripts of lib/storage-reservations.ts, run on the repository's in-memory Redis (tests/redis-stub.ts) as
 * Redis runs them. They carry no "-- marktmorgen:" name line, so lib/redis-memory.ts does not know them; a test that
 * reserves a store's storage imports this file once. Matched on the exact script text: if either script changes, this
 * model no longer answers it and the reservation fails loudly in the test, never silently.
 */
import { store } from "./redis-stub";

const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
const WRITE = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[2], ARGV[2]) return 1';

const run = store.run.bind(store);
store.run = ((command: (string | number)[]) => {
  if (String(command[0]).toUpperCase() === "EVAL" && (command[1] === RELEASE || command[1] === WRITE)) {
    const keys = command.slice(3, 3 + Number(command[2])).map(String);
    const args = command.slice(3 + Number(command[2])).map(String);
    if (run(["GET", keys[0]]) !== args[0]) return 0;
    if (command[1] === RELEASE) return run(["DEL", keys[0]]);
    run(["SET", keys[1], args[1]]);
    return 1;
  }
  return run(command);
}) as typeof store.run;
