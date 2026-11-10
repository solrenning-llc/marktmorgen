from pathlib import Path
import sys,json,subprocess,socket,unittest,hashlib
base=Path(__file__).resolve().parent
root=base/'cx1-focal-3604'
sys.path.insert(0,str(base/'cx1-lupa'))
import lupa.lua51 as lua51
originalRuntime=lua51.LuaRuntime
def runtime(*args,**kwargs):
    kwargs.update(register_eval=False,register_builtins=False)
    value=originalRuntime(*args,**kwargs)
    for name in ['os','io','package','require','debug']:value.globals()[name]=None
    return value
lua51.LuaRuntime=runtime
def denied(*args,**kwargs):raise RuntimeError('CX1 real network denied')
socket.socket.connect=denied;socket.create_connection=denied
def spend():
    path=base/'cx1-3604-ledger.json';data=json.loads(path.read_text())
    if data['redisCommands']>=data['redisLimit']:raise RuntimeError('CX1 aggregate command cap')
    data['redisCommands']+=1;path.write_text(json.dumps(data))
mode=sys.argv[1]
file=root/'proofs/cx2/digital-erasure.py'
source=file.read_text(encoding='utf8')
line='            global TOTAL\n'
assert source.count(line)==1
source=source.replace(line,line+'            cx1_spend()\n')
if mode=='own':
    before='def invoke(self, phase, *, bad_fence=False, bad_json=False):'
    after='def invoke(self, phase, *, bad_fence=False, bad_json=False, bound=False, wrong_store=False, bad_source=False, prior_hash=False):'
    assert source.count(before)==1
    source=source.replace(before,after)
    before='phase=phase, person="", erasedPeople="", erasureSaturated=False, bytes=8192)'
    after='phase=phase, person=person if bound else "", erasedPeople="f"*64 if prior_hash else "", erasureSaturated=False, bytes=8192)\n        if wrong_store: row["statsId"]="another-store"'
    assert source.count(before)==1
    source=source.replace(before,after)
    before='"source": "source",'
    assert source.count(before)==1
    source=source.replace(before,'"source": "wrong-source" if bad_source else "source",')
if mode=='old':
    old=subprocess.check_output(['git','show','870df597ef253cce126c21d85a791edfa43f848f:lib/order-confirmation-outbox.ts'],cwd=root,text=True,encoding='utf8',timeout=30)
    oldline='SOURCE = (ROOT / "lib/order-confirmation-outbox.ts").read_text(encoding="utf-8")'
    assert source.count(oldline)==1
    source=source.replace(oldline,'SOURCE = __cx1_old_source')
env={'__file__':str(file),'__name__':'cx1_lua_focal','cx1_spend':spend,'__cx1_old_source':old if mode=='old' else None}
sys.argv=[str(file),str(base/'cx1-lupa')]
exec(compile(source,str(file),'exec'),env)
print('Lua implementation',runtime(max_memory=8*1024*1024).lua_implementation,'scriptSHA',hashlib.sha256(env['SCRIPT'].encode()).hexdigest(),flush=True)
if mode=='own':
    class Own(unittest.TestCase):
        invoke=env['DigitalErasure'].invoke
        def test_bound_buyer_stays_matched_without_another_hash(self):
            for phase in ['digital_option_reserved','awaiting_payment','accepted']:
                reply,row,writes,_,person=self.invoke(phase,bound=True)
                self.assertEqual(reply,'matched');self.assertEqual(row['person'],person)
                self.assertEqual(row['erasedPeople'],'');self.assertEqual(writes,[])
        def test_cross_store_row_stays_unknown_and_unwritten(self):
            reply,_,writes,_,_=self.invoke('digital_option_reserved',wrong_store=True)
            self.assertEqual(reply,'unknown');self.assertEqual(writes,[])
        def test_source_mismatch_stays_unknown_and_unwritten(self):
            reply,_,writes,_,_=self.invoke('digital_option_reserved',bad_source=True)
            self.assertEqual(reply,'unknown');self.assertEqual(writes,[])
        def test_no_extra_hash_is_appended_to_a_legacy_print(self):
            reply,row,writes,original,_=self.invoke('digital_option_reserved',prior_hash=True)
            self.assertEqual(reply,'other');self.assertEqual(writes,[])
            self.assertEqual(row,json.loads(original));self.assertEqual(row['erasedPeople'],'f'*64)
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Own)
else:
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(env['DigitalErasure'])
result=unittest.TextTestRunner(verbosity=2).run(suite)
print('author commands',env['TOTAL'],'aggregate',json.loads((base/'cx1-3604-ledger.json').read_text()),flush=True)
sys.exit(0 if result.wasSuccessful() else 1)
