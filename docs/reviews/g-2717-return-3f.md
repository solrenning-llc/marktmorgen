# Revisão Codex G — retorno #2717
Head EXATO3f26cc88728c0ae6b4bdd97120ec49bdcb0c7a14; anterior683f01edc79355d4c820008a10613274c28aea49. Pedido C6 de21h21; anúnciofc1f0242 antes do retorno.
SEM ACHADO NOVO NO RETORNO FOCAL: meu MÉDIO de página vazia está FECHADO. As recusas dos desconhecidos continuam nos controles. Isto não substitui a segunda nominal da Claude4 nem aceita o LEVE dela sobre a rota de endereço.

## Leitura e prova causal
Li TODO delta683..3f: dois caminhos,15inserções/1exclusão (6e02430f/3f26cc88). O único ajuste funcional acrescenta rows.length antes de exigir a resposta da lista de bloqueados, exatamente a resposta que a página vazia não pediu. Nenhuma leitura suplementar nova.
Também preservei a leitura inteira do deltae1..683 já registrada: auth/request, auth, imports, bot-check e a evidência. Os novos controles do login mantêm dentro/past/unknown separados, e o aviso novo segue a ordem C4; não trato essa mudança como defeito.
- Minha prova ORIGINAL tests/g-2717-empty-page.proof.ts, blobc76c148c17dfc479556d1234ca9d09f31f207bea, BYTE-IDÊNTICA:683 dá7/2falhas ->3f7/7. Curso vazio após touchStudent→setBlocked→forgetLearnerPerson REAL volta a200/total0/data[]; página intermediária vazia conserva next37. Nenhum bloqueio foi apagado como remendo.
- MESMO teste final do autor sg2-l3-counts (blobce19fccf1d30a95e0b1de9b3d65ef7baeed3f326):683184/2falhas ->3f184/184.
- Controle adicional G tests/g-2717-empty-boundaries.proof.ts, blobca954ced5e372863a332a52c7b654e130538a64e:68328/4falhas ->3f28/28. Cobre cursor0/37, blocked0/1/200/201 (nos dois lados de BLOCKED_READ_MAX), exatamenteum pipeline inicial/nenhuma leitura suplementar, admissão com contagens exatas. Total ou bloqueados desconhecidos continuam recusados antes da admissão.
- A prova G ORIGINAL311a59d0f7c15af9dc376cdd204454a770c64221 também foi executada INALTERADA:29/30 no3f. O único FAIL é o controleantigo [0,"1"] que esperava zero aviso. A Claude4 pediu expressamente avisar uma vez por chamada, sem anotar, quando SISMEMBER=0 confirmado e total desconhecido. Não apresento o original como30/30 nem como regressão.
- Cópia IDENTIFICADA tests/g-2717-boundaries-policy-return.proof.ts, blobc5b39c49e2bdf02e91170a77567ee30a0469f11b:30/30. Diff exato: um comentário de identificação e APENAS a expectativa desse cenário de0 para1 e-mail, com zero gravações. Mesmos cinco cenários de aviso, mesmos outros25controles de API/sessão/pass e demais expectativas. Original preservado. Nenhuma asserção de página vazia/desconhecida foi afrouxada.


## Verificação e limites
-128arquivos relacionados no head:113grupos check/5057verificações e15grupos node:test/110testes, todos verdes. Incluem consumidores auth/learn/imports, API, cópia de pessoa, perfil, member-health, rotas login/endereço e bot-check. Os verdes do consumidor member-health não fecham o catch→Map→0 conhecido, que pertence ao S/#2473 e tem prova própria fora deste delta.
-Strict do recorte/imports/duas provas originais e duas adicionais:exit0. ESLint0; scanner3804arquivos rastreados/0; diff-check0.
-Nenhuma mudança em preço/limite/flag, produto/reserva/ramo/CI do autor ou merge. Sem Redis nativo/Upstash, navegador/tecnologia assistiva, fornecedor real, buildglobal, hostedCI ou certificação completa de margem.
-Runners com mkdtemp descartável. Mails e demais provedores apenas sintéticos.

Meu MÉDIO5793946540 FECHADO; meu anterior5793821629 continua fechado pelos controles preservados. SEM ACHADO no retorno focal conferido. A segunda Claude4 em5794036114 fecha seus quatro apontamentos anteriores e mantém um LEVE próprio em app/api/store/address/route.ts:85 (unknown→limited/“Wait an hour”); o autor já anunciou a correção. Não o autofecho nem declaro o PR inteiro liberado antes da disposição dessa segunda revisão e dos nove agregadores verdes do head final. G não incorpora nem repete CI.
