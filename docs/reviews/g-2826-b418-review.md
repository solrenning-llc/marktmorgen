# Codex G — revisão independente de #2826

**Head exato b418a0400e1c837fe2ae6a209760c261c725791b: um MÉDIO no encerramento da árvore de processos.** O processo direto é encerrado e a falha é contada, mas seu descendente pode sobreviver e manter stdout/stderr abertos depois que o próprio executor terminou.

## Escopo lido e RED anterior

Anúncio no canal19283993b12b55fa51aae900c4e680c252769d03 ANTES do diff e das provas. Li o diff inteiro contra main5d2c7bdc: três arquivos, tests/run.mjs, tests/test-runner.mjs e tests/test-runner.test.ts; li também os três arquivos atuais completos. Branch de prova codex/g-review-2826-test-timeout baseado no b418 exato; nenhum arquivo/ref/CI do autor alterado.

Conferi os commits RED do autor:18d5ded313ba74115d5d699b2d0b96b9732dbe99 só adiciona testes ao main5d2;1bf4920abaabe5563ae9f4e5cc3dcac11fa680c7 só acrescenta testes ao produto8f1278a0. Repeti o arquivo FINAL de11 testes BYTE-ID como cópia própria no checkout1bf: **11 testes/4 falhas**. No b418: **11 testes/1 falha**. Não anuncio11/11 neste ambiente.

As três falhas de wiring/compilação sem término/next() fecham. O teste do diagnóstico ainda espera state=/wchan= em todo Linux, mas neste executor o PID real controlável por process.kill(pid,0) não tem entrada acessível em /proc/<pid>: ENOENT, embora /proc/self exista. procState retorna o fallback documentado proc=unreadable. Registrei a limitação de ambiente, sem atribuí-la à causa dos travamentos do GitHub ou promovê-la a outro achado de produto. Nenhuma asserção do autor foi afrouxada para obter um verde.

## MÉDIO — matar só o filho permite descendente vivo e saída aberta

**tests/test-runner.mjs:107–110**, também o encerramento antecipado em106. child.kill('SIGKILL') atinge só o worker direto; a promessa termina no exit desse worker. Um teste pode iniciar um subprocesso, como as próprias provas do runner fazem. O descendente herda stdout/stderr e continua vivo; liberar a promessa não encerra sua tarefa nem os descritores de saída.

[Prova1,285f70bb](https://github.com/solrenning-llc/marktmorgen/blob/285f70bbfe0a5f1b4f657345b51b49fa959a0383/tests/g2826-descendant-cleanup.proof.mjs), SHA256a09a97f5ff501d63ba1b538f744470d470057ded769edf2940bc5d08e2624de5:
- usa runBundle REAL, processos Node REAIS locais e timeout sintético1,2s, sem substituir spawn/kill;
- worker inicia descendente por fork, espera a mensagem IPC ready; o descendente mantém um interval e herda a saída;
- depois do limite, runBundle responde1, o worker direto sumiu, **process.kill(pidDoDescendente,0) ainda confirma o descendente vivo**;
- o teste seguinte saudável retorna0 enquanto o descendente ainda está vivo;
- um diagnose() que lança erro não impede contar a falha, controle aprovado;
- **MESMOS bytes no1bf e b418:6 verificações/1 falha**, cinco controles passam. É lacuna da unidade do timeout, já presente na versão8f anterior ao b418; não regressão específica do diagnóstico.

[Prova2,43c69845](https://github.com/solrenning-llc/marktmorgen/blob/43c698459a635c4a344731a93b9974600e84fcc1/tests/g2826-inherited-output.proof.mjs), SHA2560a12a598f59fb206aff313c9b75590c2ed3d7e8254f646e22421ace1b9609488:
- um supervisor inicia o executor sintético com stdout/stderr em pipes;
- esse executor usa runBundle REAL, conta o timeout como1, imprime DRIVER_FINISHED1 e termina explicitamente com exit0;
- o supervisor recebe exit0, mas **não recebe close**, e o descendente está vivo;
- ao matar APENAS o PID sintético registrado, **close chega**, sem outra alteração;
- **MESMOS bytes1bf/b418:4 verificações/2 falhas**, controles de exit correto e liberação após cleanup passam.

A falha não depende da leitura de /proc: a existência é conferida por signal0 e a retenção de saída por eventos exit/close reais. A primeira exploração usava presença de /proc como existência e foi DESCARTADA; não conta como prova. As versões finais usam signal0, identificam proc=unreadable só como diagnóstico e sempre encerram os próprios PIDs em finally. A prova1 observa signal0 desaparecer depois do cleanup; a prova2 observa close depois da limpeza. Nenhum processo alheio foi tocado.

**Impacto demonstrado:** um timeout não contém todos os processos da tarefa, permite sobreposição com o próximo teste e deixa a saída herdada aberta mesmo depois de o executor terminar. Isso pode manter quem coleta os pipes aguardando e contraria a finalidade de não deixar um arquivo preso consumir a etapa inteira. Grau MÉDIO de confiabilidade/isolamento do CI. Não alego que esta seja a causa dos quatro verify travados após backup-run, nem impacto em dados, usuários, pagamentos ou custo em dólares.

Pedir ao autor encerramento da árvore própria por tarefa, adequado às plataformas suportadas, e prova permanente com worker+descendente mantendo a saída. Preservar testes serializados, os diagnósticos, os códigos de saída, a medida de600s e o tratamento de compilação travada. Não escrevi a correção, não alterei o workflow e não pedi retry.

## Medida do limite reconferida

Busquei pelo conector os logs ORIGINAIS dos jobs127943351314 e127891038519. Entre os cabeçalhos consecutivos dos arquivos, os maiores intervalos observados são contract-admission-ack: **100,818s** em1382 cabeçalhos e **53,859s** em1313 cabeçalhos. Os durations Node internos correspondentes são100676,451934ms e53766,602105ms. Os arredondamentos100,8/53,9 do PR estão sustentados. tests/product-checks.yml não foi confundido: o workflow é .github/workflows/product-checks.yml, verify:46 e timeout-minutes:50 em50.600s é cerca de6x100,8s e abaixo dos50min; isso não fecha a lacuna de processos acima.

Os logs integrais têm milhões de caracteres e não foram republicados: só trechos de cabeçalho/duração/contagens e a comparação dos cinco maiores intervalos estão nas saídas próprias. Fontes: https://github.com/solrenning-llc/marktmorgen/actions/jobs/127943351314 e https://github.com/solrenning-llc/marktmorgen/actions/jobs/127891038519.

## Verificações e limites

- Canonical final11/10 aprovados/1 falha de /proc documentada; RED anterior11/7 aprovados/4 falhas. Não é11/11 ou suíte inteira.
- Ligados backup-run96/96 e backup-store32/32: **128/128**, seleção final exit0. A primeira seleção incluía ci-full-tree.test.ts inexistente: os128 já passavam, mas o comando falhou ao tentar aquele arquivo; seleção corrigida sem mudar testes/assertivas. Não é defeito do PR.
- TypeScript focal1 raiz/imports exit0; lint6 caminhos exit0; scanner4068 rastreados0 e quatro próprios0; diff-check completo do PR exit0.
- Linux/Nodev24.22.1 locais; sem comprovar macOS/Windows/CI global ou reproduzir o travamento específico de backup. Não mudei produto, limites/flags/travas de produto, preços, reserva, CI/ref alheio ou merge. Nenhum browser/Redis/provedor/conta/pagamento real.

[Saídas e medidaseec80f7e](https://github.com/solrenning-llc/marktmorgen/blob/eec80f7e0f2ce64cf029e11aaf48b9b965fc49a4/docs/reviews/g-2826-b418-output.txt),25753caracteres. Provas/runner/config em branch próprio, sem execução persistente de processos. Coordenação C4 única/C1OFF. Parecer adicional, sem substituir cruzado fixo por inferência.
