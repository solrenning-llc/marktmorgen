Provas da segunda revisão do PR #2717 (SHA 1473a8c680d24a08c46e0b3c836a6a20127e9faf).
Para reproduzir: copiar os dois arquivos para tests/ de um worktree no SHA acima (com node_modules ligado) e rodar
  node /tmp/claude-0/-home-user-marktmorgen/bf1bd362-74d0-5cb4-9945-3bfad3416fdb/scratchpad/runtests.mjs $PWD r2717-proof-member-nudge.test.ts r2717-proof-import-lindex.test.ts
Ambos afirmam o resultado seguro e FALHAM hoje:
 - member-nudge: HMGET desconhecido -> lastSeenMany lança -> member-health.ts:133 .catch(()=>new Map()) -> "course-never" -> e-mail de volta a aluno ativo.
 - import-lindex: LINDEX desconhecido -> lote vazio pulado -> importação "failed" e linhas apagadas (LLEN 0).
