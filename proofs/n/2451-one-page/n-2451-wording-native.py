import json,pathlib,subprocess,hashlib
root=pathlib.Path('n-2451-candidate');manifest=json.load(open('n-2451-wording-main-manifest.json'))
def tree(changes):
 files={x['path']:(x['mode'],x['sha']) for x in manifest};files.update({p:('100644',s)for p,s in changes.items()});node={}
 for p,e in files.items():
  n=node;parts=p.split('/')
  for part in parts[:-1]:n=n.setdefault(part,{})
  n[parts[-1]]=e
 def emit(n):
  rows=[]
  for name,v in n.items():
   if isinstance(v,dict):mode,kind,sha='040000','tree',emit(v)
   else:mode,sha=v;kind='blob'
   rows.append(f'{mode} {kind} {sha}\t{name}\0'.encode())
  return subprocess.check_output(['git','mktree','-z','--missing'],cwd=root,input=b''.join(rows)).decode().strip()
 return emit(node)
base=tree({});assert base=='f029ebdb34dc177049452ec57f3f3044809c25cf'
own=['lib/email-platforms.ts','lib/email-platform-faq.ts','tests/email-platform-target-evidence.test.ts','tests/email-platform-faq.test.ts','tests/email-platform-target-world.ts','tests/test-config.mjs']
changes={p:subprocess.check_output(['git','hash-object','-w',p],cwd=root).decode().strip()for p in own}
for f in ['n-2451-wording-main-platform.ts','n-2451-wording-main-config.mjs','n-2451-wording-evidence/snapshots/lib__email-platform-faq.ts','n-2451-wording-evidence/snapshots/tests__email-platform-faq.test.ts']:
 subprocess.check_output(['git','hash-object','-w','--stdin'],cwd=root,input=pathlib.Path(f).read_bytes())
final=tree(changes);diff=subprocess.run(['git','diff','--check',base,final],cwd=root,capture_output=True,text=True);assert diff.returncode==0,diff.stderr+diff.stdout
paths=[x['path'] for x in manifest if(root/x['path']).is_file()]+own
for i in range(0,len(paths),100):subprocess.run(['git','add','--',*paths[i:i+100]],cwd=root,check=True,stdout=subprocess.DEVNULL)
out={'main':'278effa5348b97d9db50c8a6d447804efeb9be41','main_tree':base,'final_tree':final,'own_blobs':changes,'main_blobs':len(manifest),'materialized_tracked':len(subprocess.check_output(['git','ls-files','-z'],cwd=root).split(b'\0'))-1,'changed_diff_exit':diff.returncode}
pathlib.Path('n-2451-wording-native.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
