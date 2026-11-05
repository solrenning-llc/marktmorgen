"""Execute the exact corrective Lua on disposable native Redis. No remote service or credentials."""
from pathlib import Path
import importlib.util,json,re,socket,subprocess,tempfile,time
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('g2_redis',root/'scripts/test_crm_pipelines_redis.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source=(root/'lib/lesson-comments.ts').read_text();scripts={}
for name in ('WRITE_REPLY','DELETE_THREAD'):
 match=re.search(r'const '+name+r' = `([^`]+)`;',source);assert match and '${' not in match.group(1);scripts[name]=match.group(1)
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
with tempfile.TemporaryDirectory(prefix='g2-thread-redis-') as directory:
 p=subprocess.Popen(['/tmp/marktmorgen-redis-7.4.12/src/redis-server','--bind','127.0.0.1','--port',str(port),'--save','','--appendonly','no','--dir',directory],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);client=None
 try:
  deadline=time.monotonic()+5
  while True:
   try:connection=socket.create_connection(('127.0.0.1',port),timeout=10);break
   except OSError:
    if time.monotonic()>deadline:raise
    time.sleep(.02)
  client=m.Redis.__new__(m.Redis);client.sock=connection;client.stream=connection.makefile('rb');c=client.command
  keys=['g2:comments','g2:lesson','g2:all','g2:replies'];lesson='lessonone001'
  def row(id,parent=None,text='Stored comment'):
   return json.dumps(dict(id=id,l=lesson,b='creator',n='',t=text,a=100,r=parent),separators=(',',':'),ensure_ascii=False)
  def seed(id,parent=None):
   raw=row(id,parent);c('HSET',keys[0],id,raw);c('ZADD',keys[1],100,id);c('ZADD',keys[2],100,id)
   if parent:c('HINCRBY',keys[3],parent,1)
   return raw
  def delete(id):return c('EVAL',scripts['DELETE_THREAD'],4,*keys,id,lesson,102000,128,16)
  def reply(id,parent):return c('EVAL',scripts['WRITE_REPLY'],4,*keys,parent,lesson,id,row(id,parent),101,50,1000)
  def reset():c('DEL',*keys)
  parent='aaaaaaaaaaaa';answer='bbbbbbbbbbbb';successor='cccccccccccc'
  reset();rp=seed(parent);rr=seed(answer,parent);assert reply(successor,parent)==[1,1,1,0,2]
  expected=sum(((len(raw.encode())+512+15)//16)*16 for raw in (rp,rr,row(successor,parent)))
  assert delete(parent)==[3,expected];assert delete(parent)==[0,0];assert reply('dddddddddddd',parent)==[0,0,0,0,0];assert c('HLEN',keys[0])==0
  print('PASS native reply-first and delete-first ordering, exact UTF-8 room, duplicate deletion')
  reset();seed(parent);seed(answer,parent);bad=json.loads(row(answer,parent));bad['r']={'unknown':True};c('HSET',keys[0],answer,json.dumps(bad));assert delete(parent)==[-1,0];assert c('HLEN',keys[0])==2
  print('PASS malformed link stops the exact Lua before any deletion')
  reset();seed(parent);seed(answer,parent);c('HSET',keys[3],parent,'1.5')
  try:delete(answer)
  except RuntimeError as error:assert 'integer' in str(error)
  else:raise AssertionError('expected integer error')
  assert c('HGET',keys[0],answer) is None and c('HGET',keys[0],parent) is not None
  print('OBSERVED native-only boundary: fractional stored reply counter causes late HINCRBY error after reply deletion')
  reset();seed(parent);c('HSET',keys[3],parent,'0.5')
  try:reply(answer,parent)
  except RuntimeError as error:assert 'integer' in str(error)
  else:raise AssertionError('expected integer error')
  assert c('HGET',keys[0],answer) is not None
  print('OBSERVED native-only boundary: fractional stored reply counter causes late HINCRBY error after reply insertion')
  reset();fixture=json.loads((root/'.review-output/lesson-delete-cost-fixture.json').read_text())
  for id,raw in zip(fixture['ids'],fixture['rows']):
   c('HSET',keys[0],id,raw);c('ZADD',keys[1],100,id);c('ZADD',keys[2],100,id)
  c('CONFIG','RESETSTAT');start=time.monotonic()
  for id in fixture['ids']:assert delete(id)[0]==1
  elapsed=time.monotonic()-start
  stats=c('INFO','commandstats');counts={name:int(n) for name,n in re.findall(r'cmdstat_(\w+):calls=(\d+)',stats)}
  gets=len(fixture['ids'])*(len(fixture['ids'])+1)//2+len(fixture['ids'])
  assert counts['hget']==gets,(counts,gets);assert c('HLEN',keys[0])==0
  commands=sum(n for name,n in counts.items() if name not in ('info','config'))
  result=dict(records=len(fixture['ids']),commands=commands,hget=gets,seconds=elapsed,registeredStudioUnit=fixture['studioUnit'],funded=fixture['studioUnit']*len(fixture['ids']),commandOnlyUsd=commands*fixture['commandUnit'],wholeScaleStudioMonth=fixture['scaleStudioMonth'])
  (root/'.review-output/lesson-delete-native-cost.json').write_text(json.dumps(result,indent=2));print('MEASURED native actual commandstats:',json.dumps(result))
  assert result['commandOnlyUsd'] <= result['funded'], 'RED: exact deletion script exceeds the studio units admitted before its scan'
 finally:
  if client:client.close()
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
