# 126 [F2-MULTIPLE-COMMUNITIES] — Estudo antes de construir (11/11/2026)

Claude 4 (nuvem B), unidade 0 do item 126. **Somente documento:** nenhum código, preço, limite, comissão, flag ou trava muda. A fila pede: "antes de começar, conferir sobreposição no código, na fila 203–275 e no já publicado; absorção somente com prova, parcial somente pela diferença". Este estudo mede essa diferença no main de 11/11/2026, confere a sobreposição com a fila (seção 4) e propõe as unidades seguintes. Estado VR: **na fila** (nada novo funciona para o cliente).

## 1. O que já existe

- **Uma comunidade por loja.** O registro da loja guarda `community: CommunityRef | null`, com `{ id, on }` (`lib/store.ts`, `CommunityRef`). Todas as chaves ficam sob `nl:cm:${id}`: configuração, membros, posts, comentários, pontos, chat, mensagens privadas, eventos, avisos, busca e e-mails.
- **Espaços dentro da comunidade** (`Space` em `lib/community.ts`, até `MAX_SPACES` = 20, em `lib/community-text.ts`). Cada espaço tem:
  - nome e descrição próprios;
  - `creatorOnly`: só o criador começa posts;
  - `only`: só os compradores de certos produtos veem o espaço. `visibleSpaces` (`lib/community-access.ts`) filtra a lista, e `lib/community-gate.ts` fecha a entrada;
  - `level`: o nível mínimo para começar um post.
- **Acesso pela compra.** `CommunityConfig.access` define os produtos cujos compradores entram, e a confirmação por espaço fica guardada por `config.v`.

Na prática, **"uma área só para quem comprou o curso X" já existe**: é um espaço com `only = [X]`. Repetir isso como "comunidade nova" seria construir de novo o que existe (VR, item 6).

## 2. A diferença real: o que um espaço não separa

Hoje continuam valendo para a comunidade inteira, mesmo com espaços fechados:

| Parte | Onde está | Efeito para o criador que quer dois públicos |
| --- | --- | --- |
| Lista de membros (diretório) | `directory`, `directorySize` e `memberPage` em `lib/community.ts` | Quem comprou só o produto A vê o nome e o perfil de quem comprou só o B. |
| Chat ao vivo | `lib/community-chat.ts` | Uma sala só para todos. |
| Mensagens privadas | `lib/community-dm.ts` | Qualquer membro pode escrever a qualquer outro, conforme `dm`. |
| Pontos, níveis e classificação | `lib/community-points.ts` e `lib/community-levels.ts` | Uma classificação única. |
| Perguntas de entrada e boas-vindas | `questions` e `welcome` em `CommunityConfig` | As mesmas para todos. |
| Nome, descrição e endereço | `name` e `about`, `/<handle>/community` | Uma marca e um endereço só. |
| E-mails da comunidade e cancelamento | `lib/community-mail.ts`, `nl:cm:unsub:` | Um único "parar de receber". |
| Moderação: denúncias, silenciar e retirar | `report` e `reportQueue`; `moderateMember`, com `muted` e `removed` no registro do membro (`lib/community.ts`) | Uma fila de denúncias só. Quem é silenciado ou retirado fica assim em todos os espaços. |

Esta é a diferença que o item 126 pode acrescentar. O resto já está no main.

## 3. Dois caminhos

### (A) Separar por espaço o que hoje é da comunidade inteira

Os espaços com `only` ganhariam uma opção "private group" (nome provisório). Com ela ligada, o diretório, a classificação e a sala de chat mostram só quem pode ver o espaço.

- **A favor:**
  - reaproveita as chaves `nl:cm:${id}`, a exclusão (`lib/community-erasure.ts`), a exportação e o fechamento da loja, que já cobrem a comunidade toda;
  - nenhum registro novo por pessoa;
  - a pessoa que comprou A e B continua com um perfil só.
- **Contra:**
  - um nome e um endereço só;
  - mexe em leituras que outros agentes estão alterando agora: `claude3/community-search-ceiling`, `claude5/cm1-locked-community` e os ramos `claude2/*community*`. Exige coordenação de reservas.
- **Moderação:** continua por comunidade, como hoje (tabela da seção 2). Nenhuma unidade de (A) a separa por espaço.
- **Custo (MR), ainda em aberto:**
  - `visibleSpaces` responde se **quem está vendo** pode ver cada espaço fechado: uma resposta por espaço fechado e por visitante, até 20, já contada hoje;
  - um diretório, uma classificação ou um chat que mostram só quem pode ver o espaço precisam dessa resposta para **cada membro listado** (página do diretório × espaços fechados), ou de um índice de membros por espaço gravado na entrada. O pior caso é maior que o de hoje, e este estudo não o mediu;
  - a unidade 2 escolhe o desenho e mede essa linha em `tests/plan-cost-registry.ts` antes do código.

### (B) Várias comunidades de verdade por loja

A loja passaria a guardar uma lista: `communities: CommunityRef[]`, com um endereço por comunidade.

- **A favor:**
  - marcas, nomes e endereços separados;
  - tudo separado de fato.
- **Contra (medido):**
  - 44 arquivos de `lib/` e `app/` leem `store.community` ou `community.id`, com ou sem `?.` (103 ocorrências, no main de 12/11/2026, contadas com `git grep -lE 'store\??\.community|community\??\.id' -- lib app` e, para as ocorrências, `git grep -ohE` com o mesmo padrão). Cada um precisaria escolher qual comunidade;
  - a exclusão de pessoa, a cópia de dados, o fechamento da loja e os registros `tests/store-data-registry.ts` e `tests/plan-cost-registry.ts` teriam de percorrer N comunidades;
  - a mesma pessoa vira N registros de membro, um por comunidade: mais espaço na sala de dados e mais pontos de falha na exclusão (regra 28 da CX-123);
  - surge um limite novo por plano: quantas comunidades. Acrescentar um limite não corta nenhum limite visível, mas o número e o custo de cada comunidade a mais precisam entrar no pior caso de cada plano (MR) antes de qualquer venda.
- **Risco:** é a maior mudança de modelo de dados da comunidade desde a criação dela, e está em cima de arquivos que pelo menos três agentes estão alterando.

## 4. Sobreposição com a fila (203–275 e outros itens)

Li o título dos itens 203 a 275 e o texto inteiro dos que tratam de comunidade. Pelo título, os demais não tocam na comunidade.

| Item | O que pede | Relação com este estudo |
| --- | --- | --- |
| 233 [SK1] | Página pública "About" de cada comunidade, indexada | É a mesma necessidade do nome e do endereço próprios de (B). Se o dono escolher (B), a página de SK1 precisa ser por comunidade desde o início. Nenhuma unidade de (A) toca nessa página. |
| 234 [SK2] | Descoberta de lojas e comunidades | Lista uma comunidade por loja. Com (B), a listagem teria de ser por comunidade. Sem efeito em (A). |
| 235 [SK3] | Perfil único do membro em todas as comunidades | É o mesmo problema dos "N registros de membro por pessoa" de (B): os dois precisam do mesmo desenho de perfil, e fazer (B) antes de SK3 arrisca refazê-lo. Mais um motivo para (B) esperar a decisão do dono. |
| 263 [CI1] | Moderação assistida por IA | Acrescenta à moderação que existe, que é por comunidade. Como (A) não separa a moderação por espaço, CI1 não muda. |
| 264 [CI2] | Resumo semanal da comunidade | Já usa a verificação de acesso da busca. Se o resumo incluir o chat, a sala por espaço precisa entrar no mesmo filtro. |
| 116 [F2-COMMUNITY-CHANNELS] (fora da faixa) | Vários chats, grupos, permissões entre grupos e moderação | Cobre a unidade 4 deste estudo (a sala de chat por espaço) e se cruza com as unidades 1 a 3 ("grupos"). |

**O que muda na recomendação:**
- a unidade 4 sai deste item e fica em 116 [F2-COMMUNITY-CHANNELS];
- as regras da unidade 1 são desenhadas junto com 116, para não haver dois modelos de grupo;
- (B) também depende de 233 [SK1] e 235 [SK3].

**O já publicado:** conferido só pelo código do main (seções 1 e 2), não no site.

## 5. Recomendação

1. **Fazer (A) primeiro, em unidades pequenas**, porque entrega ao criador a separação de públicos que (B) daria, sem duplicar perfis nem mexer em 44 arquivos.
   - Unidade 1: regras puras, ou seja, quem um "private group" deixa ver no diretório, na classificação e no chat, com teste que falha antes. As regras são desenhadas junto com 116 [F2-COMMUNITY-CHANNELS] (seção 4).
   - Unidade 2: o diretório filtrado, com a linha de custo.
   - Unidade 3: a classificação.
   - Unidade 4: a sala de chat por espaço, construída em 116 [F2-COMMUNITY-CHANNELS], não neste item (seção 4).
   - Unidade 5: a opção no estúdio, com o texto da ajuda dizendo exatamente o que fica separado e o que não fica (VR, item 2).
2. **(B) só se o dono quiser marcas ou endereços separados dentro da mesma loja.** Essa é uma decisão de produto, não técnica. Hoje uma segunda loja já dá marca e endereço próprios. Fica para "Depende do dono", via Claude 1, sem construir nada até lá. Se for escolhido, vem depois de 235 [SK3] e junto com 233 [SK1] (seção 4).
3. **Antes da unidade 1:** reservar os arquivos com os donos atuais dos ramos de comunidade, pelo Claude 1. Nenhuma unidade começa sobre arquivo reservado por outro agente.

## 6. O que este estudo não verificou

- **Concorrentes:** não li fontes oficiais datadas hoje. Nenhuma comparação é feita aqui (VR, item 7).
- **Custo:** não medi o custo real das leituras filtradas. A linha de custo é trabalho da unidade 2.
- **Pessoas reais:** não testei com pessoas reais (item 202). O número de passos e decisões do criador fica para a unidade 5.

## Acessibilidade

Documento interno; nenhuma página mudou. Para a unidade 5, a opção "private group" precisa de:

- rótulo e ajuda em inglês americano simples (3.1.5);
- o estado anunciado ao leitor de tela (4.1.2);
- nenhuma mudança de contexto ao marcar (3.2.5);
- confirmação antes de esconder membros de quem já os via (3.3.6).
