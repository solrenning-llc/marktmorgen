import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedDigitalOption,selectedDigitalOptionForFolder} from '@/lib/digital-option-confirmation';
import {vaultPath} from '@/lib/vault-rules';
const option=()=>({id:'original_file',label:'Printable edition',priceCents:6500,
 file:{pathname:'stores/synthetic/original_file/original.pdf',name:'Original.pdf',bytes:1200,contentType:'application/pdf',addedAt:'2026-11-01T00:00:00.000Z'},
 link:null,details:['Original file'],best:false});
const select=(o:unknown)=>selectedDigitalOption({options:[o]},'original_file');

test('copies exact original paid-file identity and detaches file and descriptions from the catalog',()=>{
 const o=option(),c=select(o);assert.ok(c);assert.deepEqual(c,o);assert.notEqual(c,o);assert.notEqual(c.file,o.file);assert.notEqual(c.details,o.details);
 o.label='Changed catalog';o.priceCents=1;o.file.pathname='replacement.pdf';o.file.bytes=1;o.details[0]='Changed';
 assert.equal(c.label,'Printable edition');assert.equal(c.priceCents,6500);assert.equal(c.file.bytes,1200);
 assert.equal(c.file.pathname,'stores/synthetic/original_file/original.pdf');assert.deepEqual(c.details,['Original file']);
});
test('the detached projection is frozen at every mutable level without freezing the input',()=>{
 const o=option(),c=select(o);assert.ok(c);
 assert.equal(Object.isFrozen(c),true);assert.equal(Object.isFrozen(c.file),true);assert.equal(Object.isFrozen(c.details),true);
 assert.equal(Reflect.set(c,'priceCents',1),false);assert.equal(Reflect.set(c.file,'name','Changed.pdf'),false);assert.equal(Reflect.set(c.details,'0','Changed'),false);
 assert.equal(Object.isFrozen(o),false);assert.equal(Object.isFrozen(o.file),false);assert.equal(Object.isFrozen(o.details),false);
});
test('ambiguous, missing and unknown selections cannot fall back to another catalog option',()=>{
 for(const options of [[],[option(),option()],[option(),{...option(),id:'other'}]])assert.equal(selectedDigitalOption({options},'original_file'),null);
 for(const id of [undefined,null,'',0,'other','x'.repeat(25)])assert.equal(selectedDigitalOption({options:[option()]},id),null);
});
test('this paid-file recipe does not infer free-delivery rights from a zero or unknown price',()=>{
 for(const priceCents of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'6500',null,{}])assert.equal(select({...option(),priceCents}),null);
 assert.equal(select({...option(),priceCents:1})?.priceCents,1);
});
test('missing file, link delivery, mixed delivery and SKU coupling stay outside this projection',()=>{
 for(const patch of [{file:null},{link:'https://example.test/file'},{sku:'stock_reference'},{extra:true}])assert.equal(select({...option(),...patch}),null);
 const o:Partial<ReturnType<typeof option>>=option();delete o.best;assert.equal(select(o),null);
});
test('a file must have all five own metadata fields, with no hidden extras',()=>{
 const original=option();for(const field of ['pathname','name','bytes','contentType','addedAt']){
  const file:Record<string,unknown>={...original.file};delete file[field];assert.equal(select({...original,file}),null);
 }
 assert.equal(select({...original,file:{...original.file,extra:true}}),null);
});
test('unknown or noncanonical file sizes never become zero through coercion',()=>{
 for(const bytes of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1200',null,{}])assert.equal(select({...option(),file:{...option().file,bytes}}),null);
 assert.equal(select({...option(),file:{...option().file,bytes:1}})?.file.bytes,1);
});
test('bounded file text and a canonical original timestamp preserve exact metadata',()=>{
 for(const patch of [{pathname:''},{pathname:'x'.repeat(2001)},{name:' '},{name:'x'.repeat(256)},{name:'Bad\nname'},
  {contentType:''},{contentType:'x'.repeat(256)},{addedAt:''},{addedAt:'not-a-date'},{addedAt:'2026-11-01T00:00:00Z'},
  {addedAt:'2026-02-30T00:00:00.000Z'}])assert.equal(select({...option(),file:{...option().file,...patch}}),null);
 const o=option();Object.assign(o.file,{pathname:'x'.repeat(2000),name:'x'.repeat(255),contentType:'x'.repeat(255)});assert.ok(select(o));
});
test('option labels and descriptions retain bounded original values without normalization',()=>{
 for(const patch of [{id:'bad id'},{label:''},{label:'x'.repeat(41)},{label:'Bad\nlabel'},{best:1},
  {details:Array(9).fill('line')},{details:['x'.repeat(101)]},{details:['bad\0line']}])assert.equal(select({...option(),...patch}),null);
 assert.ok(select({...option(),label:'x'.repeat(40),details:Array(8).fill('x'.repeat(100))}));
});
test('executable descriptors are refused without running option, file or description getters',()=>{
 let reads=0;const get=()=>{reads++;throw Error('No executable metadata');};
 const o=Object.defineProperty(option(),'file',{get});assert.equal(select(o),null);
 const f=Object.defineProperty(option().file,'bytes',{get});assert.equal(select({...option(),file:f}),null);
 const d=option();Object.defineProperty(d.details,'0',{get});assert.equal(select(d),null);
 const options=[option()];Object.defineProperty(options,'0',{get});assert.equal(selectedDigitalOption({options},'original_file'),null);assert.equal(reads,0);
});
test('inherited, sparse and array-like metadata cannot masquerade as the original file choice',()=>{
 assert.equal(select(Object.create(option())),null);assert.equal(select({...option(),file:Object.create(option().file)}),null);
 const options=[option()];delete options[0];assert.equal(selectedDigitalOption({options},'original_file'),null);
 for(const product of [null,[],{options:{0:option(),length:1}},{options:false}])assert.equal(selectedDigitalOption(product,'original_file'),null);
});
test('capturing metadata creates no payment, access, source or financial permission',()=>{
 const c=select(option());assert.ok(c);assert.deepEqual(Object.keys(c),['id','label','priceCents','file','link','details','best']);
 for(const key of ['permitsCheckout','grantsAccess','token','reviewId','owner','accountId','sourceValue'])assert.equal(Object.hasOwn(c,key),false);
});
test('the selected file must match both the provided original folder and option ID',()=>{
 const o=option(),product={options:[o]};
 const c=selectedDigitalOptionForFolder(product,o.id,'synthetic');assert.ok(c);assert.deepEqual(c,o);assert.equal(Object.isFrozen(c.file),true);
 assert.equal(selectedDigitalOptionForFolder(product,o.id,'another_store'),null);
 assert.equal(selectedDigitalOptionForFolder(product,'another_option','synthetic'),null);
});
test('the parent product folder cannot substitute for the selected option folder',()=>{
 const o=option();o.file.pathname='stores/synthetic/parent_product/original.pdf';
 assert.ok(select(o),'plain metadata capture is deliberately not path ownership');
 assert.equal(selectedDigitalOptionForFolder({options:[o]},o.id,'synthetic'),null);
});
test('existing vault paths preserve exact store and option identities',()=>{
 const folder='0123456789abcdef0123456789abcdef',other='abcdef0123456789abcdef0123456789';
 const o=option();o.file.pathname=vaultPath(folder,o.id,'0123456789abcdef','Original.pdf');
 assert.ok(selectedDigitalOptionForFolder({options:[o]},o.id,folder));
 assert.equal(selectedDigitalOptionForFolder({options:[o]},o.id,other),null);
 o.file.pathname=vaultPath(folder,'parent_product','0123456789abcdef','Original.pdf');
 assert.equal(selectedDigitalOptionForFolder({options:[o]},o.id,folder),null);
});
test('prefix collisions, nested objects, traversal and external file URLs refuse',()=>{
 for(const pathname of ['stores/synthetic/original_file_more/original.pdf','stores/synthetic/original_file/sub/file.pdf',
  'stores/synthetic/original_file/../file.pdf','stores//synthetic/original_file/file.pdf',
  'https://example.test/stores/synthetic/original_file/file.pdf']){
  const o=option();o.file.pathname=pathname;assert.equal(selectedDigitalOptionForFolder({options:[o]},o.id,'synthetic'),null);
 }
});
test('a folder must be an explicit bounded string, never executable or coerced metadata',()=>{
 let reads=0;const executable={toString(){reads++;throw Error('No coercion');}};
 for(const folder of [undefined,null,0,'',' ',' synthetic','synthetic ','x'.repeat(321),'synthetic/other','synthetic\\other','bad\nfolder',executable])
  assert.equal(selectedDigitalOptionForFolder({options:[option()]},'original_file',folder),null);
 assert.equal(reads,0);
});
test('matching a pathname adds no authenticated owner, token, access or funding evidence',()=>{
 const c=selectedDigitalOptionForFolder({options:[option()]},'original_file','synthetic');assert.ok(c);
 assert.deepEqual(Object.keys(c),['id','label','priceCents','file','link','details','best']);
 assert.equal(Object.hasOwn(c,'storeFolder'),false);assert.equal(Object.hasOwn(c,'grantsAccess'),false);
});
