"""Own disposable Redis only. Exact application scripts, no provider/account."""
import json,os,re,socket,subprocess,time,uuid
from pathlib import Path
from test_form_opportunity_redis import Redis
root=Path(__file__).resolve().parents[1]
def script(path,name):
 m=re.search(r'(?:export )?const '+name+r' = `(.*?)`;', (root/path).read_text(),re.S);assert m;return m[1]
take=script('lib/store-data.ts','TAKE_DATA');room=script('lib/campaign-landing-store.ts','LANDINGS_ROOM').replace('${TAKE_DATA}',take)
write=script('lib/campaign-landing-store.ts','WRITE_LANDINGS').replace('${LANDINGS_ROOM}',room)
drop=script('lib/campaign-landing-store.ts','DROP_LANDINGS').replace('${LANDINGS_ROOM}',room)
assert '${' not in write+drop
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
p=subprocess.Popen(['/tmp/marktmorgen-redis-7.4.12/src/redis-server','--bind','127.0.0.1','--port',str(port),'--save','','--appendonly','no'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
db=None
try:
 for i in range(100):
  try:sock=socket.create_connection(('127.0.0.1',port),timeout=.1);break
  except OSError:time.sleep(.02)
 else:raise RuntimeError('Owned Redis not ready')
 db=Redis.__new__(Redis);db.sock=sock;db.stream=sock.makefile('rb')
 prefix='marktmorgen:review:g2:landing:'+uuid.uuid4().hex+':'
 keys=[prefix+'room',prefix+'record'];old=json.dumps([{'campaign':'original','headline':'Known','sub':'','button':''}]);new=json.dumps([{'campaign':'stale-request','headline':'Later','sub':'','button':''}])
 def save(expected,value):return db.command('EVAL',write,2,*keys,2000000,'2026-11','al:p',1024,expected,value)
 first=save('',old);assert first[0]==1;assert db.command('GET',keys[1])==old
 removed=db.command('EVAL',drop,2,*keys,2000000,'2026-11','al:p');assert removed[0]==1;assert db.command('GET',keys[1]) is None
 stale=save(old,new);assert stale==[3,0]
 retry=save('',new);assert retry[0]==1;assert db.command('GET',keys[1])==new
 print(json.dumps({'initial':first[0],'deleted':removed[0],'staleExpectedRefused':stale[0],'retryAfterAbsentAccepted':retry[0],'recreated':True,'provider':False}))
finally:
 if db is not None:db.stream.close();db.sock.close()
 p.terminate();p.communicate(timeout=5)
