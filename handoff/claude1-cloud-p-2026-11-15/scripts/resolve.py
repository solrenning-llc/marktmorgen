# Usage: python3 -I resolve.py <file> <index> <replacement-file>
# Replaces the <index>-th (0-based) conflict block of <file> with the replacement text.
import sys, re
path, idx, rep = sys.argv[1], int(sys.argv[2]), open(sys.argv[3]).read()
s = open(path).read()
blocks = list(re.finditer(r'<<<<<<< [^\n]*\n.*?\n=======\n.*?>>>>>>> [^\n]*\n', s, re.S))
b = blocks[idx]
s = s[:b.start()] + rep + s[b.end():]
open(path, 'w').write(s)
print(f"{path}: block {idx} of {len(blocks)} replaced")
