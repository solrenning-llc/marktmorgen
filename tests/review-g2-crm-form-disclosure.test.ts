import test from 'node:test';
import assert from 'node:assert/strict';
import {PERSON_DATA} from '@/lib/person-data';
test('G2: CRM retention disclosure must not say a plain form clears deletion',()=>{
 const row=PERSON_DATA.find(d=>d.file==='lib/crm.ts'&&d.how==='kept');
 assert(row&&row.how==='kept');
 assert(!row.why.includes('or a form they send'),'forms.test confirms a plain form preserves the deletion mark');
});
