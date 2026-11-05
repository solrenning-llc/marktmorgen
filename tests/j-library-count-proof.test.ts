import assert from 'node:assert/strict';
import {waitingLine, type Waiting} from '@/lib/buyer-waiting';
const found:Waiting={requests:[],agreements:Array.from({length:10},(_,i)=>({id:String(i),kind:'agreement',title:'Synthetic',expiresAt:0})),requestsTotal:0,agreementsTotal:11,unread:false};
assert.match(waitingLine(found),/more than 10 proposals or agreements to sign/);
console.log('Capped list preserves the larger counted total.');
