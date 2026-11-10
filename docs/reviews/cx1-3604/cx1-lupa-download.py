from pathlib import Path
import urllib.request,json,hashlib,zipfile
root=Path(__file__).resolve().parent
name='lupa-2.8-cp314-cp314-win_amd64.whl'
expected='3903c9cf628dae2f56405503247b77a61a3a61bd2dda470e336950c74776d55d'
request=urllib.request.Request('https://pypi.org/pypi/lupa/2.8/json',headers={'User-Agent':'CX1-local-review-runtime'})
with urllib.request.urlopen(request,timeout=30) as response:meta=json.load(response)
entry=next(x for x in meta['urls'] if x['filename']==name)
assert entry['digests']['sha256']==expected
assert entry['url'].startswith('https://files.pythonhosted.org/')
with urllib.request.urlopen(entry['url'],timeout=30) as response:content=response.read(4*1024*1024)
assert hashlib.sha256(content).hexdigest()==expected
wheels=root/'cx1-lupa-wheels';wheels.mkdir(exist_ok=True)
archive=wheels/name;archive.write_bytes(content)
target=(root/'cx1-lupa').resolve();assert target.is_relative_to(root.resolve());target.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as wheel:
    for entry in wheel.infolist():assert (target/entry.filename).resolve().is_relative_to(target)
    wheel.extractall(target)
(root/'cx1-lupa-runtime.json').write_text(json.dumps({'name':name,'sha256':expected,'bytes':len(content),'source':'https://pypi.org/project/lupa/2.8/','isolatedUnderRepository':True},indent=2)+'\n')
print('isolated runtime ready',name,len(content),expected,flush=True)
