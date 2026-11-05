import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MCP_TOOLS} from '../lib/mcp-catalog';
test('G title and summary preparation are advertised together',()=>{
 const names=MCP_TOOLS.map(t=>t.name);
 assert.ok(names.includes('propose_product_title')&&names.includes('propose_product_summary'));
});
