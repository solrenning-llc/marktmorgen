"""
273 [BK1], inbox C4-30: how long a key's DUMP is against the bytes the
application sends (its key and values) and against Redis's own MEMORY USAGE,
for every kind of key the stores keep (docs/backup-cost-2026-11-04.md, section
5, item 6). Run against a local, empty, throwaway Redis on port 6399:
redis-server --port 6399 --save "" --appendonly no. It refuses a Redis that
holds any key, in any database, or whose keyspace it cannot read, and never
flushes one. Synthetic values only; nothing real is read or written.
"""
import json
import random
import string
import subprocess
import sys
def dump_len(k):
    # DUMP returns binary; use redis-cli --raw piped length minus trailing newline
    out = subprocess.run(["redis-cli","-p","6399","--raw","DUMP",k], capture_output=True).stdout
    return len(out)-1
def mem(k): return int(subprocess.run(["redis-cli","-p","6399","MEMORY","USAGE",k,"SAMPLES","0"],capture_output=True,text=True).stdout.strip())
random.seed(1)
rnd=lambda n: ''.join(random.choice(string.ascii_letters+string.digits) for _ in range(n))
cases=[]
def add(name, key, logical):
    d=dump_len(key); m=mem(key)
    cases.append((name, logical, d, m))
def keyspace_empty():
    # An unreadable or unexpected answer is not "empty".
    info = subprocess.run(["redis-cli","-p","6399","INFO","keyspace"],capture_output=True,text=True)
    lines = [line.strip() for line in info.stdout.splitlines() if line.strip()]
    return info.returncode == 0 and lines == ["# Keyspace"]
if not keyspace_empty():
    sys.exit("Refused: the Redis on port 6399 is not an empty throwaway (it holds keys, or its keyspace could not be read). Nothing was written or flushed.")
# strings
for n in [10, 100, 1000, 10000, 100000]:
    k=f"nl:s:{n}"; v=rnd(n); subprocess.run(["redis-cli","-p","6399","SET",k,v],capture_output=True); add(f"string random {n}B",k,len(k)+n)
for n in [1000, 100000]:
    k=f"nl:z:{n}"; v="a"*n; subprocess.run(["redis-cli","-p","6399","SET",k,v],capture_output=True); add(f"string repetitive {n}B",k,len(k)+n)
# json-ish
k="nl:json"; v=json.dumps({"rows":[{"id":rnd(12),"email":rnd(10)+"@example.com","n":i} for i in range(200)]}); subprocess.run(["redis-cli","-p","6399","SET",k,v],capture_output=True); add(f"string JSON {len(v)}B",k,len(k)+len(v))
# hash
for f in [10, 100, 1000]:
    k=f"nl:h:{f}"; args=[]; lg=len(k)
    for i in range(f):
        fn=f"f{i}"; fv=rnd(20); args+= [fn,fv]; lg+=len(fn)+len(fv)
    subprocess.run(["redis-cli","-p","6399","HSET",k,*args],capture_output=True); add(f"hash {f} fields",k,lg)
# set
for f in [10, 1000]:
    k=f"nl:set:{f}"; m=[rnd(16) for _ in range(f)]; subprocess.run(["redis-cli","-p","6399","SADD",k,*m],capture_output=True); add(f"set {f} members",k,len(k)+16*f)
# zset
for f in [10, 1000]:
    k=f"nl:zs:{f}"; args=[]
    for i in range(f): args+=[str(random.random()*1e12), rnd(16)]
    subprocess.run(["redis-cli","-p","6399","ZADD",k,*args],capture_output=True); add(f"zset {f} members",k,len(k)+(16+8)*f)
# list
k="nl:list"; m=[rnd(30) for _ in range(500)]; subprocess.run(["redis-cli","-p","6399","RPUSH",k,*m],capture_output=True); add("list 500 items",k,len(k)+30*500)
# HLL
for f in [10, 1000, 100000]:
    k=f"nl:hll:{f}"
    for c in range(0,f,1000):
        subprocess.run(["redis-cli","-p","6399","PFADD",k,*[rnd(12) for _ in range(min(1000,f-c))]],capture_output=True)
    add(f"HyperLogLog {f} adds",k,len(k)+int(subprocess.run(["redis-cli","-p","6399","STRLEN",k],capture_output=True,text=True).stdout.strip()))
print(f"{'case':28} {'logical':>9} {'DUMP':>9} {'base64':>9} {'MEMORY':>9} {'DUMP/log':>9} {'b64/log':>8} {'DUMP/mem':>9}")
for name,lg,d,m in cases:
    b64=4*((d+2)//3)
    print(f"{name:28} {lg:9d} {d:9d} {b64:9d} {m:9d} {d/lg:9.3f} {b64/lg:8.3f} {d/m:9.3f}")
