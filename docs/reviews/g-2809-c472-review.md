# Revisão Codex G de #2809 — envelope externo e dependência herdada

Head EXATO c4722dd18bff758d5b590c1775e4dd5427171350. Nominal C4-1925-TODOS-114; anúncio no canal f4b9491c702de1b65156d0c606311642b8f92aab antes do diff/testes (o409 anterior NÃO aplicou; esperei135s e reenviei prefixo completo fresco). Li TODO b7..c472:2arquivos392+/1-, incluindo387linhas do canônico novo, BYTE-ID à minha dc41d0d7 após só a linha de crédito. Li a implementação REAL do helper importado neste head, não presumi que já fosse a do main. R1 canal12h30 creditado; a referência dele a07e46739 não foi assumida como head atual: as leituras API deste retorno continuaram apontando c472.

## Parecer: LEVE nominal do envelope extra FECHADO; ressalva LEVE herdada de integração do #2806

**Fechado:** o envelope externo de um único EVAL agora é passado por repliesFor(...,1) e envelope com posição extra lança. Prova externa dc41d0d7 SEM alterar67asserções: **67/67**, era67/2 no b7. Canônico copiado67/67; prova interna cd3eee2167/67. Controles saudáveis e aplicado/ACK perdido, externa e interna:67/67 em cada um. Curso real M1 de65a22480:64/64. Nenhuma perda de compra ou acesso foi inferida de teste cuja fronteira deixou de existir.

**LEVE herdado — lib/redis-reply.ts:24–25, chamado por lib/order-data.ts:236–238.** Este snapshot ainda traz o helper antigo, blob8f7534b6803cdb4b032265da616bcf3a739ddb14: apenas Array.isArray+length, devolvendo o próprio array. Um slot acessor de tamanho correto é devolvido e invocado na desestruturação. É a classe de endurecimento JÁ corrigida pelo #2806 no main, não uma regressão da comparação de tamanho do novo delta e não pedido de corretivo duplicado.

Prova identificada tests/g2809-restore-outer-getter.proof.ts@6419d32f21982a4a8944113faa23570c8b5537eb: mesma corrida real de curso e script de restauração, mas resposta externa de uma posição é um accessor que devolve [0,0,1]. Sem aplicar o script. Acrescenta um check de que getter de recibo desconhecido não seja chamado. **c472:68checks/3falhas**, getter chamado, matrícula null, watch antigo removido; **pai b7 mesmos bytes68/3**, herdado. Controle saudável nativo68/68. O leitor real de cursos continua abrindo pela compra preservada: NÃO é novo M1, perda atual de acesso nem MÉDIO.

**Alcance do grau:** é objeto anômalo de um adaptador JavaScript local. JSON legítimo de Upstash não transporta getters. Não afirmo exploração remota, poluição de protótipo causada pelo cliente ou incidente de produção; classifico LEVE de contrato de dados próprios, já tratado no helper compartilhado do main.

### A dependência já tem solução no main, comprovada sem editar o produto

Busquei lib/redis-reply.ts do main EXATO095e46a3e53fd810205465b385c075bb02a3a497: blob**46519ad14e82a3e0f446a6a17fb236a2f552b686**, BYTE-ID ao #2806/bc9 revisado. Ele aceita só slot de dados próprio e devolve cópia.

Em ensaio de união IDENTIFICADO, compilei c472 com SOMENTE esse helper exato via alias explícito do runner, mantendo todo produto rastreado intocado. A MESMA prova68checks passou **68/68**, getter não executado, ordem vigiada e matrícula recuperada na retomada. Isso é GREEN da UNIÃO, **não GREEN do c472 sozinho** e não merge real. Não alego ensaio de todos os arquivos do main ou de toda árvore de merge.

Artefatos legíveis: tests/g-main-reply.snapshot.ts@02b73af7bbec4107491c80c6ccda64abfb3e94bf (git hash-object confirma46519ad), runner explícito tests/g2809-main-reply-joint-run.mjs@bdf7d739e3fdd83a6c4120b0195049dbfc6dee3b. Sem troca de arquivo lib/ do autor nem publicação de produto G.

**Condição da ressalva:** preservar/trazer o helper já corrigido pelo #2806 antes ou junto da incorporação; o main já o tem. Não peço nova implementação, preço, limite, flag ou trava, nem altero base/ramo/CI. Um futuro head realmente integrado pode fechar essa ressalva com a mesma prova, sem repetir a revisão inteira. O parecer não é aprovação global incondicional do snapshot antigo do helper.

## Testes e limites

45arquivos canônicos de consumidores de learn/orderWrite/paypal (manifesto b7 acrescido do novo canônico), mais3custo/memória: **48arquivos/1963checks customizados+84node PASS**,1teste Redis7SKIPPED. Provas próprias, controles e repetições focais separados; getter nativo esperado vermelho e união verde NÃO entram nesse total como testes do head puro.

tsc -p tsconfig.g2809-c472.json:exit0,13raízes/imports recorte estrito, não global. eslint5paths:exit0,0erros/12avisos herdados de imports nas cópias da fixture. git diff --check0; produto rastreado intocado na cópia /tmp/g2809-return-c472, só provas/snapshot/runner/config próprios não rastreados. Nenhum novo IO do delta fora validação já tratada; não certifico cobrança/margem geral nem trato custo desconhecido como zero.

Saídas docs/reviews/g-2809-c472-output.txt@95aa770e5e85606ba33c992acef2f959e2e9e7cb, config6cb789f193e0a68dad1f79f37aa4af2c66f3f4d9, próprio codex/g-review-2809-concurrent-payment. Parent b7 getter foi reexecutado em cópia própria; seu resultado68/3 também está explicitado aqui, não confundido com correção do envelope extra.

Não fiz Redis/Lua nativo, fornecedor/conta/pagamento real, browser/AT, build/CI global ou merge. C4 única coordenação/C1 desligado; revisão independente adicional respeita CX72. Caminho “sem room” citado pelo R1 permanece nota de coerência dele, não inventei loja real sem identificador para chamar isso de falha produtiva.
