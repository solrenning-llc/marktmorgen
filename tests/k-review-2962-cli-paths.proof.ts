/** Prepared #2962 import control. NOT executed: its subprocess budget was used for the same-wiring CLI-preimage baseline. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Result = { status: number | null; stdout: string; stderr: string };
export function verifyImportBoundary(sourceRoot: string, run: (args: string[], cwd: string) => Result) {
  const temp = mkdtempSync(join(tmpdir(), 'k2-2962-import-'));
  try {
    const folder = join(temp, 'açaí 100% literal%20 # path'); mkdirSync(folder);
    const cli = join(folder, 'marktmorgen.mjs'); copyFileSync(join(sourceRoot, 'cli/marktmorgen.mjs'), cli);
    const bytes = readFileSync(cli);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), '11884fee8e261141996bec28949c7b8cfe9b354a');
    writeFileSync(join(temp, 'package.json'), '{"type":"module"}\n');
    const importer = join(temp, 'marktmorgen');
    writeFileSync(importer, `globalThis.fetch = async () => { throw Error('External IO forbidden'); }; await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log('importer-only');\n`);
    const result = run([importer], temp);
    assert.equal(result.status, 0, 'an unrelated entry named marktmorgen imports without running the CLI');
    assert.equal(result.stdout, 'importer-only\n', 'import does not print CLI help or terminate its caller');
    assert.equal(result.stderr, '', 'import does not emit an API-key error');
    console.log('INDEPENDENT_CLI_IMPORT_CONTROL', JSON.stringify({ checks: 4, status: result.status, stdout: result.stdout, stderr: result.stderr, copiedSourceBlob: '11884fee8e261141996bec28949c7b8cfe9b354a' }));
    return { checks: 4 };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
