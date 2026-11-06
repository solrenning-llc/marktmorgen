import { readFileSync } from "node:fs";

let checks = 0;
function is(name: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`not ok ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
    return;
  }
  console.log("  ok   ", name);
}

const harness = readFileSync("tests/e2e/deals-board-harness.tsx", "utf8");
const check = readFileSync("tests/e2e/deals-board-focus.mjs", "utf8");

const boardStart = harness.indexOf("function Board(");
const rootStart = harness.indexOf("const root = createRoot", boardStart);
const board = harness.slice(boardStart, rootStart);
const mountStart = harness.indexOf("mount(world: World)");
const mount = harness.slice(mountStart, harness.indexOf("\n  },", mountStart));
const helperStart = check.indexOf("const mount = async (w) => {");
const helper = check.slice(helperStart, check.indexOf("\n  };", helperStart));

async function controlledRemount() {
  let mountedEpoch = 4;
  const requestedEpoch = 5;
  let publishCommit!: () => void;
  const commit = new Promise<void>((resolve) => {
    publishCommit = () => {
      mountedEpoch = requestedEpoch;
      resolve();
    };
  });

  // The old board's title is already visible when the next render is requested.
  await Promise.resolve();
  const oldTitleReturnedBeforeCommit = mountedEpoch !== requestedEpoch;

  let gateReturned = false;
  const gate = commit.then(() => {
    gateReturned = mountedEpoch === requestedEpoch;
  });
  await Promise.resolve();
  const gateReturnedBeforeCommit = gateReturned;
  publishCommit();
  await gate;
  return { oldTitleReturnedBeforeCommit, gateReturnedBeforeCommit, gateReturned };
}

controlledRemount().then((result) => {
  is(
    "a stale title returns before the controlled commit, while the epoch gate does not",
    result,
    { oldTitleReturnedBeforeCommit: true, gateReturnedBeforeCommit: false, gateReturned: true },
  );

  is("the harness records both requested and committed mount epochs", /requestedEpoch:\s*number/.test(harness) && /mountedEpoch:\s*number/.test(harness), true);
  is("mount publishes the requested epoch to the caller", /this\.requestedEpoch\s*\+=\s*1/.test(mount) && /return this\.requestedEpoch/.test(mount), true);
  is("the new board receives the same requested epoch", /<Board\s+key=\{[^}]+\}\s+epoch=\{this\.requestedEpoch\}\s*\/>/.test(mount), true);
  is("the board publishes its epoch only from a layout effect", /useLayoutEffect\(\(\)\s*=>\s*\{\s*page\.harness\.mountedEpoch\s*=\s*epoch;\s*\},\s*\[epoch\]\)/.test(board), true);

  const requested = helper.indexOf("window.harness.mount(w)");
  const committed = helper.indexOf("window.harness.mountedEpoch === epoch");
  const oldTitle = helper.indexOf('page.locator("#deals-title").waitFor()');
  is("the E2E helper waits for the requested epoch to commit", requested >= 0 && committed > requested, true);
  is("the stale title cannot satisfy remount readiness", committed >= 0 && (oldTitle < 0 || committed < oldTitle), true);
  is("the remount gate has no fixed sleep", /waitForTimeout|setTimeout/.test(helper), false);

  console.log(`\n${checks} checks complete.`);
});
