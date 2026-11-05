# Revisão Codex G — #2717
Head EXATO: 62be56436da672c637186729144947785f1f58bf. Base: 6725b5c97d9bd8d26cd7cfd215c33521bacd4513.
Anúncio antes da revisão: canal887170e859e73b490fb352e74be9a702bde3e0ff. Primeira independente; Claude4 assumiu a segunda de sessão. Sem implementação/reserva/ramo/CI alheio/merge.

Li o diff inteiro dos quatro caminhos (313 inserções/35 exclusões), incluindo todos os testes e chamadores relevantes: auth/request, passkeys, API students, person-erasure e o loop/catch dos imports. A revisão é deste head; o complemento studentDates/lastSeenMany pedido pela C4 às20h48 ainda não está nele e exige retorno quando publicado.

## Um MÉDIO residual/herdado — studentPage ainda converte respostas desconhecidas em dados completos
lib/learn.ts:599–606 e :614–625; exposição pela rota app/api/v1/students/route.ts (HTTP200).
O PR fecha HLEN/SCARD, mas não a forma da página/progresso/bloqueio que a mesma função devolve. Reproduções com loja, produto, curso, API key, aluno e bloqueio reais em Redis em memória:
- Controle nativo: HTTP200, total1, um aluno, blocked=true.
- Substituir APENAS o pipeline HSCAN/HLEN/SCARD por [["0",null],1,1] ou [["0",{result:[]}],1,1]: HTTP200/{total:1,data:[],next:null}. O leitor atesta fim da paginação de dados que não conseguiu ler. Hash com campo sem valor ou JSON inválido dá o mesmo resultado, sem indicar parcial.
- Com a linha real intacta, substituir APENAS o SMEMBERS suplementar da lista de bloqueados por null: HTTP200 com o aluno realmente bloqueado dito blocked=false. Controle posterior confirma linha e bloqueio persistidos, nenhuma alteração dos dados pela falha.
Não é concessão de acesso ao curso e não alego que este PR introduziu a classe: os cinco vetores já falham na base. É residual do leitor tocado pelo L3 e da promessa de aceitar só respostas exatas. A API já tem o caminho502/unavailable para uma página não confirmada; deve usá-lo, ou declarar parcial de forma contratada, sem certificar vazio/desbloqueado. Conferir envelope externo, cursor, pares/campos e cada resposta suplementar antes de afirmar dados completos. Não aumentar preço/limite nem adicionar leitura sem custeio.

Prova opt-in tests/g-2717-boundaries.proof.ts, blob311a59d0f7c15af9dc376cdd204454a770c64221. MESMO arquivo final nos dois códigos: base30verificações/14falhas -> head30/5falhas. Cinco são o MÉDIO acima; as outras nove fecham as fronteiras exercitadas de fresh EXISTS, novo navegador e exclusão. Inclui controle de uma solicitação de passkey depois de endSession: rota REAL401/signed_out. Não confundo a marca fresh que ainda existe com autorização; o chamador valida a sessão antes. Inclui pass REAL mintPass, leitura desconhecida recusada sem apagar o índice, nova tentativa exata removendo de fato a identidade do navegador.

A primeira execução LOCAL da fixture usou credencial sintética que o harness não conhece, logo seu controle positivo de aviso não enviava; corrigido para a literal sintética já permitida. Também testava isFreshSession após logout como se fosse autorização: o contrato do helper é só a marca, então o controle final usa a rota real que autoriza passkeys. Nenhum desses dois ensaios iniciais é achado. Depois só let→const para lint, com ambos os códigos repetidos no arquivo FINAL acima. As cinco asserções causais da API permaneceram iguais.

## RED/GREEN e validação
- MESMO teste final do autor sg2-l3-counts: base102/74falhas -> head102/102.
- Minha prova final:30/14 ->30/5, com os limites de alcance acima; os cinco REDs herdados da API permanecem. Mails/provedores somente sintéticos e inesperado fetch lança.
- 113 arquivos ligados por imports de auth/learn/imports:103 grupos de check/4691 verificações verdes, mais10 grupos node:test/48 testes verdes, zero falha/skip/cancel nos summaries.
- TypeScript strict do recorte de três módulos/teste/prova e imports:exit0. ESLint final0 (o primeiro lint apontou apenas let no meu teste, corrigido). Scanner3804 arquivos rastreados/0; diff-check limpo.
- Nenhuma nova chamada Redis introduzida pelo delta; validadores locais substituem coerções. Os modelos/limites comerciais não foram alterados nem certificados globalmente.
- Não executei Redis nativo/Upstash, browser, fornecedor real, build global ou hostedCI; não alego nove checks de CI verdes.

Resultado: não libero o L3 inteiro com este MÉDIO no leitor. As correções dos contadores/sessão/exclusão/imports exercitadas passaram, mas falta o retorno no novo head e a segunda revisão independente de sessão. O complemento de datas que C4 pediu continua separado e não foi antecipadamente certificado.
