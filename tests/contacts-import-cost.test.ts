import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTACT_IMPORT_WORK as work, pastedContactWork } from '@/lib/contact-import-rules';
import { MAX_IMPORT } from '@/lib/contact-rules';
import { IMPORT_WORST_COMMANDS_PER_ROW } from '@/lib/import-limits';
import { UNIT_COST, COMMAND, DB_BYTE } from './plan-cost-registry';
test('paste admission covers the complete finite command and byte envelope in existing studio units',()=>{
 for(const rows of [1,2,50,100,499,500,501,1000,MAX_IMPORT]){
  const cost=pastedContactWork(rows),units=cost.extraStudioUnits+1;
  assert.ok(Number.isSafeInteger(units)&&units>0);
  assert.ok(units*work.commandsPerStudioUnit>=cost.commands);
  assert.ok(units*work.bytesPerStudioUnit>=cost.bytes);
  assert.ok(units*UNIT_COST.studio>cost.commands*COMMAND+cost.bytes*DB_BYTE);
 }
 assert.deepEqual(pastedContactWork(0),{commands:0,bytes:0,extraStudioUnits:0});
 for(const bad of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>pastedContactWork(bad));
});
test('the native script observations fit the file import per-row ceiling',()=>{
 // Measured using the exact production Lua in Redis, with INFO/EVAL/INFO in MULTI/EXEC.
 for(const [rows,commands] of [[50,158],[100,308],[500,1508]]){
  // One HSETNX per row, plus fixed read/data-room/job/report work. Uploads
  // count at least 50 rows; the exact integration proof runs in the Redis job.
  assert.ok(commands+rows+64<=rows*IMPORT_WORST_COMMANDS_PER_ROW);
 }
});
