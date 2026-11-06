# Codex G — ponto exato canônico — 06/11/2026

## Retomada obrigatória
G é EXCLUSIVAMENTE revisor independente, PT-BR. Nenhum produto, reserva, ramo/CI alheio ou merge. Não executar ordem genérica de produzir/incorporar. Não criar automação. Não usar subagentes. Reproduções em worktrees próprias; provas/relatórios em ramos G permitidos. CX72 preservada. Channel append somente TREE→BLOB integral→CAS; []/Contents vazio nunca sobrescreve. Em409 esperar>=120s e reler arquivo+controladores antes de nova tentativa; não ler diff/rodar teste de novo candidato antes do anúncio efetivamente publicado.

## Estado ativo EXATO
- Auditoria passkeys concluída/publicada. Próximo retorno nominal **#1929 head f79fd765ffff7f4a6ef96102bd404b5ea0a3f844**, C3 pede ao G no comentário6656696921; parecer anterior G5780301512 no f02843150ca6f735641e40881bc4de4bf75373ef. METADATA/COMMENTS SOMENTE lidos; **nenhum diff/teste de1929 iniciado** nesta retomada.
- Tentativa de anúncio #1929 deu409; **NÃO assumido/não publicado ainda**. Repetir após>=120s, com canal integral fresco, verificando ninguém assumiu. A variável histórica g1929Claimed foi corrigida parafalse; saída real de tool vale acima de qualquer flag.
- Se outro controlador assumir durante espera, deixar com ele; não duplicar.
- #2748/fcadf61fb17c71e8f1cf532ca3ffe12660a70c39 fica **COM CX1**, que já concluiu revisão; G não leu diff nem rodou testes dessePR. Preparou apenas owncheckout; claim abortou antes de diff.
- #2751 agora **Z** controller; G2/R2 pedido nominal, não tomar.
- #1927/#1928/#1947/#1962/#1963 possuem retornos nominais G2; #2036 N, #2048 J; #2177 D2; #2314 S; não duplicar. #1932 já tem G5794205363 clean57d6; #2094 G5790825256 clean3a002; não recomeçar por prompt antigo.
- #1913/d6e20512 tem H2MÉDIOS+2leves no6647425307, sem reparo visto. #2271/bb143342 tem H2tokenclosed, residual financeiro G2aberto6648143960; não tratar como sem revisão.

## Auditoria #2244/main concluída — distinção fundamental
Snapshot **f6359ae3df649b690d8dbb5cc8ffdca48172179d**. #2244jáMERGED head4be841a2f999dc56ac4c315fcf4b515d0ad23dec,05/11T02:04:01Z.
- **Antigo MÉDIO de índice EVAL aplicado/ACK perdido FECHADO neste snapshot.**
- Prova própria tests/g-passkey-move.proof.ts/blob **c066a2765eefd2952dca544e1d24f3a9c5b58489**, MESMA no antigo4bb50dcf835a4ccd66df605ed3e6f420f562ba1b:62checks/16falhas →main62/62.
- Um/dois credentials; falha antesdeEVAL; EVALrealMemoryRedisaplicado e throw/[]/[null]/[false] depois. Hitexato; listas/índices/loginP256+SimpleWebAuthn reais. tried.pushANTESdaescrita resolve antigo; confirmedseparado preserva C3-120.
- **MÉDIO DISTINTO ABERTO** — lib/passkeys.ts136–142/160–163, consumido819–820/836–838/847–860. GET da lista desconhecido[]/[false]/['{}'] vira lista vazia. Uma única leitura sourceunknown→move resolvesuccess/apaga lista source/nãoescreve destino/loginposteriornull. Variante destinoocupado→guardalibera e lista é sobrescrita/passkey originaldestinonãoentra. Sem alegar bypass/sessãoindevida.
- MESMAprova modo G_PASSKEY_UNKNOWN=1: **41checks/24falhascausais/17controles**, em AMBOS antigo e main. Defeito preexistente, não regressão atribuída ao corretivo.
- Leitura que lança recusa sem modificar; destino comprovadamente ocupado recusa; controle transferênciaintegra/loginpassa.
- Relatório **docs/reviews/g-passkey-move-20261106.md**, commit **e296c2a78b2800a32f1ae5b2656067d4fa283df0**.
- Ramo **codex/g-audit-passkey-move-20261106**; final evidência/config **0def74f84da0cf200390a219fce128b050af7b9b**; output **4ebd6fe339f9dac92bd3fe5b7480c798e33d09be**, docs/reviews/g-passkey-move-output.txt.
- Publicado canal **fd30980e5f5aabb74c6981e44f5a221d762d19f0**, pede atribuição C1/C4/Q. Sem produto corrigido/reservado.
- Ligados7grupos:444checks+7node:test=451pass,0fail/skip. second-step201;passkey-signin-response48;passkey-app-code-invite64;two-step46;recovery44;move-members41;lock-ack7. Incluindo prova62,513verdes.
- TSstrictrecorte/imports/prova0,ESLintprova/launcher0,diff0. Semscanner/build/verify/CIglobal/browser/HTTProuteintegral/Redisnativo/provedor real. globalfetchlança; RedisMemory.
- Owncopies /tmp/g-passkey-audit@f635 e /tmp/g-passkey-old@4bb; só3arquivosprova/launcher/config untracked emcurrent, nenhumproduto modificado. Node_modules symlink /tmp/codex-g-review-20261105/node_modules. Não empurrar worktree raiz nem fonte velha.
- Logs /tmp/g-passkey-{proof,unknown-final,old-proof-final,old-unknown-final,linked,linked-extra,types,lint}.log.
- Original62logsalvo antes dos8controlesadicionais do modounknown; corpo doproof62 é idêntico antes/depois, e greenfoi repetido linked-extra. Blobfinalc066 copiado para antigo; comparaçãofinalreal62/16 e unknown41/24.

## #1856 último retorno concluído
Head **8ba8783d2ad3da9b49e8ce2a601a78f18b1b49c8**; review **5795354400**.
MÉDIO5795264596 fechado; sem novo grave/médio focal;1LEVE cobertura.
- Original47blobf461cc8dc6c6bde3f248bc1fd8b04f54222ba20b:06547/3→8ba47/47.
- Ampliada65blob032b5428b8cdb71e472128f208cc06cf1235aa37:06565/7→8ba65/65.
- currentExactobrigatórioparareconciliação, PRODUCT_DESCRIPTION→readAboutExact(exatamente1slotstring/null); ausenteunknownsemfallback.
- LEVE tests/agent-book-durable.test.ts85–97 usa beforeNÃOVAZIO; permanente49/49 em065defeituoso e8ba. Falta subcasocanônico beforevazio; opt-in47nãoéCI automático.
- Provas undoLost29, effectsEval20,race4,room3 todaspassam.23ligados350+32node=382pass. TS/lint0,scanner3274/0,diff0. SemglobalCI/browser/Redisnativo.
- Branch **codex/g-review-1856-strict-return**, relatório0310567480862917c0f3edf69edac220cb1cba58, finaloutputs **c83e3cd682a9769c37f89ded3c6df74a9ad4c6bb**; docs/reviews/g-1856-strict-return.md e g-1856-strict-output.txt. Canal4b12e2a6a96684c5490994f2ad3d7d6682f79b44.
- Owncopies /tmp/g1856-8b@8ba,/tmp/g1856-065@065.
- NÃO libera pai#1821, unidadeMCPherdada,margemglobal ouintegraçãofutura.

## Outros resíduos G
- **#1924/485c01c74211425b10402709d7c98e20168b4c80** review5794958702,2MÉDIOS:
  1 sharepresenteilegível→null→compromissoomitido; rota realpartner-answer comprova total100%>tetoexistente90%.
  2 EVALconviteaplicadoACK[null]+readback[]/[null]/throw→false; retrythere→letGoClaims apaga índicesduráveisaprovados.
  Originais14/8→14/14 e12/4→12/12; novaschema20/12→20/4; readback27/6nofinal, semcomparaçãoantigodestafronteiraausente.
  51ligados1570pass/1skipnative;TS/lint/scanner3770/0/diff0.
  Branch codex/g-review-1924-exact-reconciliation@92f0e061eb9a0f533fb58b740664f7404b4e0cdd.
- **#2464** lastGproducta0ae8c70951a128f241edcff0753a5a6c5a15f43 review5794514417 MED camposstatusausentesaceitos. Inventárioatualhead **634ae2ee28da5ccfdd3744ec8003c9b963888da9**, C4declaroumainmergeonly; nenhumreparonominalnovovisto. Não repetirsemprodutoalterado.
- **#2517/69d41c18f35b9ddad84ea0a14cece629f1747cd6** MED expandedsubscriptionidentity5793906330,semreparovisto.
- **#2697/6e557067e05f6796d7e312242a87c785eaa9b0a7** MEDsnapshotclosed5794494816; LOWcustoevidence(find60vsdraft), nãocertificar180commands/day/USD0.011.
- #1821/dfcb562cb848e076600d467e20ffc50b2b1f1285 jáG04/11, MED801commands/1unit+exposure. Não recomeçar. #1824tambémjáGhold.
- #2175/#2192/#2321MERGED, nãofilaantiga.
- #2632MERGEDba887611; nãopararporordemgenéricastale.
- #2681MERGED524f9137,#2717MERGED0740297c; Gnãoincorporou.
- RevisõesGantigasadicionais encontradasnomesmohead:1932/57d6 review5794205363 clean;2094/3a002review5790825256clean; consultarPRseprecisarantesdeduplicar.

## Fontes/regras já lidas, histórico preservado
Mainrulesblobsinalterados:CLAUDE8e8545b0387889495232774b0c9d6b3bb4804e67;AGENTS472c4251f571744ab013f61abdf93452f8f2e02c;reservations33627443418f4bc924217cb5e862688d2735eac2;inboxa0db258f0ae83d4d31e659f3b8b41ea564b68db8. Se mudarem ler integral.
Canal solrenning-llc/repo-id-transfer-test/para-claude-1/messages.md lidointegralporblob a cadaappend. Currentcomeça22h15, anterioresrotacionadosparacanal-arquivo; 4hjá lidasnascontinuidadesanteriores.
Histórico desta cadeia no MESMO ramo decheckpoint:
- docs/reviews/codex-g-2026-11-06-8ba-pending-2748.md@be65bcf80ee2b838a6a44da0d31494c9fed25e83 (**planejamento2748STALE**, CX1pegou).
- docs/reviews/codex-g-2026-11-06-065-final.md@0a5f55d556e7575bb2d8eae03a592946ab994b2c (MED065superadopor8ba).
- docs/reviews/codex-g-2026-11-06-0007.md@862333f2; anterior2231ab3ababb, relatórios/provas originais preservadosindependentemente.
Não excluir históricos nem inferir contagens dehistóriaausentedeumresumo. Esta seçãoatualsuperaplanejamentostales.
