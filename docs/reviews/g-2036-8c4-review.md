# Revisão Codex G de #2036 — retorno nominal 8c4ff596

**Head exato8c4ff596d543e74393f0e62e70afcc2e65bacedc: MÉDIO5803482928 FECHADO; LEVE condicional de recibo JavaScript acessor.** Não é parecer global sem achado. Retorno pedido pela Claude3 às13h39 e C4-2215, anunciado antes de código/testes no canalcadc5075bb914475fb6968795f57b794351a7083.

Li o delta8141..8c4 inteiro:5arquivos2055+/5-. Dois produtos e runner lidos sem truncamento; prova de999linhas conferida em faixas e BYTE-ID com b3c1c878; o novo canônico é essa mesma prova após uma linha de crédito. As cópias não são duas revisões independentes. O diff integral anterior27arquivos continua coberto pelo parecer anterior; não alego nova auditoria de todo main herdado.

## MÉDIO fechado: perda da resposta de transporte

A cópia agora leva em PipelineAccessCopyUnconfirmed o estado anterior, lido sob a mesma trava, e o crescimento de sala tomado antes da escrita. O catch de moveMemberships entrega esse estado à restauração mesmo quando a escrita lançou ou retornou recibo desconhecido, antes de atribuir copied. A sala só volta depois de recibo confirmado da restauração.

- Prova congelada b3c1c878 **idêntica**, SHA256648effa3a2852bd79860efb235f6876fb26e8d163485e4aa192bbd267f30bc97: antes8141 **188verificações/1falha**, agora8c4 **188/188**. Controle G_COPY_ACK=healthy **188/188**.
- Prova originalN e06808b3, também congelada e byte-idêntica: **188/188**.
- A nova matriz real exercita destino ausente, registro anterior maior, anterior menor e origem sem restrição que apaga o destino. Cada um com escrita aplicada/não aplicada e recibo[]/exceção: todas as80asserções dessas16combinações passam. Os escritores de acesso e a movimentação são reais; não forjo registros/contadores.
- Falha adicional durante o undo:4combinações aplicou/não aplicou, []/exceção,20asserções passam quanto ao estado efetivo e à proibição de devolver sala sem confirmação. **Isso NÃO demonstra que o undo sempre terminou:** quando a segunda escrita não aplica, o registro copiado ainda fica no destino e a sala fica tomada; quando aplica e perde a resposta, os dados restauram mas a sala fica conservadora. É um limite de recuperação sob uma falha adicional, explicitamente registrado, não um sucesso de restauração ou promessa de limpeza incondicional.

## LEVE condicional — lib/pipeline-access.ts:112–113 e :171–174

oneAnswer ainda lê reply[0] diretamente. Se o pipeline APLICOU o HSET/HDEL e seu recibo é um array JavaScript cujo slot0 é um getter que lança, a exceção ocorre dentro de oneAnswer, FORA do .catch aplicado à promessa do pipeline. PipelineAccessCopyUnconfirmed não é criado; o chamador fica sem o estado para desfazer, como na fronteira antiga.

[Prova30b80d9d](https://github.com/solrenning-llc/marktmorgen/blob/30b80d9da7dac3ecfa4789f2148fd02388ca7b1d/tests/g2036-copy-recovery-matrix.proof.ts): acrescenta somente a forma applied-getter às quatro situações reais anteriores. A escrita acontece pelo pipeline real; depois a prova devolve um array local com accessor que lança. Os quatro getters rodam uma vez cada. Destinos não voltam aos bytes anteriores; em dois casos o crescimento também fica tomado.

Matriz FINAL, MESMOSbytes:
- pai8141: **124checks/32falhas**;
- head8c4: **124checks/10falhas**, todas EXCLUSIVAMENTE nos quatro casos applied-getter;
- os100checks de transporte comum/recuperação conservadora estão verdes; das24asserções dos getters,14passam/10falham.

**Grau LEVE e alcance local:** getter foi injetado no ambiente JavaScript de teste; **JSON.parse de uma resposta REST não cria getters**. Não demonstrei um caminho remoto para produzi-lo, poluição de protótipo, Proxy ou invasão, e não o classifico como novo MÉDIO financeiro/de exploração remota. É endurecimento da validação/propagação de estado contra uma resposta JavaScript não ordinária. A validação deve ler dados próprios sem executar accessor e transformar esse recibo em desconhecido com o contexto já disponível; não assumir que toda exceção só virá da promessa do transporte.

## Verificações

**37 arquivos canônicos:1897checks customizados+28node PASS,0falhas/skip**, manifesto3646af5747d96df984681ab6e0140eae9e530abc. O novo canônico188 é incluído nesse total; a cópia congelada não multiplica cobertura independente. Tipos29raízes/imports,exit0; lint5paths+final da matriz,0erros/avisos; diff-check0. As verificações finais de tipos/lint e os dois runs da matriz foram repetidos após acrescentar o caso getter.

[Saídasfdefae35](https://github.com/solrenning-llc/marktmorgen/blob/fdefae3547950fe406f5b0edde95809de5c2b6cd/docs/reviews/g-2036-8c4-output.txt), matriz30b80d9d, configb7d264d1. Evidências no ramo próprio codex/g-review-2036-copy-rollback, cuja base permanece8141; **os comandos verdes foram executados na própria cópia destacada do head8c4, /tmp/g2036-return-8c4**, não alego que a base antiga do ramo de evidências ficou verde. Pai /tmp/g2036-review-8141. Produto rastreado intocado; só prova/config/manifesto próprios não rastreados.

O disco local chegou a100% disponível. Removi só a própria cópia antiga encerrada /tmp/g1927-return-436, após conferir produto rastreado limpo e publicar todos os seus arquivos não rastreados em docs/reviews/g-1927-436-local-scratch-preserved.json@079f5256c7ce2f574d79e7e8bfbdfe47b8498d3c. Logs externos ao checkout preservados. Nenhum arquivo de outro agente removido; os testes8c4 concluíram, sem ENOSPC. O primeiro pedido de diff grande truncou: não o contei como leitura integral; reli produtos/runner e conferi fonte/testes separadamente.

Sem Redis/Lua nativo, provedor, conta/pagamento real, browser/AT, CI global ou certificação de margem. Nenhum produto/preço/limite/flag/trava/reserva/ref ou CI alheio/merge. C4 única coordenação, C1 desligado. MÉDIO anterior fechado; LEVE condicional aguarda decisão/correção do dono; não substitui cruzado fixo por inferência.
