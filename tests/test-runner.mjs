/** Keep each test process isolated and serial. */
export async function runTestFiles({files, compile, run}) {
  let failed = 0;
  for (const file of files) {
    const bundle = await compile(file);
    if (await run(file, bundle) !== 0) failed += 1;
  }
  return failed;
}
