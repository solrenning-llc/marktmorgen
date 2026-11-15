# Usage: python3 -I union.py <file>...: every conflict block becomes ours followed by theirs (exact duplicate lines once).
import re, sys
for p in sys.argv[1:]:
    s = open(p).read()
    def rep(m):
        ours, theirs = m.group(1).splitlines(True), m.group(2).splitlines(True)
        return "".join(ours + [l for l in theirs if l not in ours])
    s, k = re.subn(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', rep, s, flags=re.S)
    open(p, 'w').write(s); print(p, k)
