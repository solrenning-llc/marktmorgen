"""Run the exact company write Lua on ephemeral loopback Redis, never a provider."""
from pathlib import Path
import importlib.util,re,socket,subprocess,tempfile,time
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('review_redis_client',root/'scripts/test_crm_pipelines_redis.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
match=re.search(r'export const WRITE_COMPANIES = `([^`]+)`;', (root/'lib/crm-companies.ts').read_text())
assert match and '${' not in match.group(1);script=match.group(1)
server=Path('/tmp/marktmorgen-redis-7.4.12/src/redis-server');assert server.is_file()
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
with tempfile.TemporaryDirectory(prefix='g2-company-redis-') as directory:
 p=subprocess.Popen([str(server),'--bind','127.0.0.1','--port',str(port),'--save','','--appendonly','no','--dir',directory],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 client=None
 try:
  deadline=time.monotonic()+5
  while True:
   try: connection=socket.create_connection(('127.0.0.1',port),timeout=2);break
   except OSError:
    if time.monotonic()>deadline:raise
    time.sleep(.02)
  client=m.Redis.__new__(m.Redis);client.sock=connection;client.stream=connection.makefile('rb')
  lock='g2-review:company:lock';data='g2-review:company:records'
  assert client.command('SET',lock,'owner','EX',10)=='OK'
  assert client.command('EVAL',script,2,lock,data,'foreign','aaaaaaaaaa','first')==0
  assert client.command('HLEN',data)==0
  assert client.command('EVAL',script,2,lock,data,'owner','aaaaaaaaaa','first','bbbbbbbbbb','second')==1
  assert client.command('HGETALL',data)==['aaaaaaaaaa','first','bbbbbbbbbb','second']
  # Applied result intentionally discarded, modelling an ACK lost after actual write.
  client.command('EVAL',script,2,lock,data,'owner','cccccccccc','applied-before-lost-ack')
  assert client.command('HGET',data,'cccccccccc')=='applied-before-lost-ack'
  assert client.command('SET',lock,'successor','EX',10)=='OK'
  assert client.command('EVAL',script,2,lock,data,'owner','aaaaaaaaaa','stale')==0
  assert client.command('HGET',data,'aaaaaaaaaa')=='first'
  assert client.command('EVAL',script,2,lock,data,'successor','aaaaaaaaaa','')==1
  assert client.command('HGET',data,'aaaaaaaaaa') is None
  print('PASS exact Lua: foreign token refuses, current token writes multiple rows, applied result may be lost, successor fences stale writer, owned deletion confirms')
 finally:
  if client:client.close()
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
