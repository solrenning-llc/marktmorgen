"""Pure Python regression of the actual nested mixed_save. No sockets, Redis flag or native-Lua claim.
The fake client returns the documented SAVE v5 receipts; function AST is copied unchanged from each exact ref.
"""
import argparse, ast, json, subprocess
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--ref',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
source=subprocess.run(['git','show',args.ref+':scripts/test_form_opportunity_redis.py'],cwd=root,check=True,capture_output=True,text=True).stdout
main=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='main')
node=next(n for n in ast.walk(main) if isinstance(n,ast.FunctionDef) and n.name=='mixed_save')
failed=0
for mode,expected in [('manual-wins',1),('form-wins',1),('full',0)]:
 class Redis:
  def command(self,*parts):
   manual=parts[1]=='SAVE';record=str(parts[4]);index=int(record.split('-')[-1])
   admitted=(mode=='manual-wins' and manual and index==0) or (mode=='form-wins' and not manual and index==1)
   return ([1] if admitted else 0) if manual else ([1,'record'] if admitted else [-1,''])
  def close(self):pass
 namespace={'Redis':Redis,'save_script':'SAVE','script':'FORM','keys':['','','','owned-fixture'],'cap':1}
 exec(compile(ast.Module(body=[node],type_ignores=[]),str(root/'scripts/test_form_opportunity_redis.py'),'exec'),namespace)
 try:
  replies=[namespace['mixed_save'](i) for i in range(64)]
  total=sum(replies);ok=total==expected
  result={'mode':mode,'total':total,'expected':expected,'ok':ok}
 except Exception as error:
  ok=False;result={'mode':mode,'error':type(error).__name__,'message':str(error),'ok':False}
 failed+=not ok;print(json.dumps(result))
print(json.dumps({'ref':args.ref,'cases':3,'failed':failed,'native':False}))
raise SystemExit(1 if failed else 0)
