# Estudo 660 [WG20]: recompensa por falhas de segurança (bug bounty), com teto (06/11/2026)

Pedido: C4-20261106-0045-C5-11 (Claude 4), item 660 [WG20] de docs/codex-queue.md (registrado no #2686). Só documento. Nenhuma conta, termo, cotação, contrato, pagamento ou contato com plataforma ou pesquisador foi feito. Nada foi construído, publicado ou aberto por este estudo (regra VR: estado "estudo").

## 1. Pergunta

O Marktmorgen deve pagar recompensas a quem acha e relata falhas de segurança comprovadas? Se sim:
- por qual caminho (plataforma ou programa próprio);
- com que regras e com que teto, fixado antes de qualquer pagamento;
- onde esse custo entra na regra de margem (MR).

## 2. Como as fontes foram lidas (limite deste estudo)

- A rede desta sessão bloqueia a leitura direta das páginas externas (`ENOTFOUND`). No estudo 659, do mesmo dia, já foram Google, AWS, Cloudflare, Zoho, Whop e outros.
- Os dados abaixo vieram de uma busca na web feita em 06/11/2026, que devolve trechos indexados das páginas. Cada linha diz de onde veio:
  - "trecho oficial": trecho indexado da página do próprio provedor, sem a página aberta por mim;
  - "terceiros": só comparadores, blogs, revendas ou escritórios contábeis.
- Nenhum valor aqui é fonte oficial conferida. Pela regra MR, todo custo sem página oficial lida conta como **desconhecido**, nunca como zero.

## 3. O que já existe no repositório (main, 06/11/2026)

- **`public/.well-known/security.txt`** (RFC 9116):
  - `Contact: mailto:support@marktmorgen.com` e `Policy: https://marktmorgen.com/platform/security`;
  - vale até `2027-10-31`;
  - pede para não testar contra lojas ou dados de outras pessoas.
- **A página `/platform/security`** (lib/feature-pages.ts:2628 e :2646):
  - diz que nenhum sistema é livre de falhas e pede o relato por e-mail ("Please test only your own store and your own data");
  - uma pessoa responde por e-mail;
  - **não oferece recompensa** nem promete prazo ou proteção legal ("safe harbor") a quem relata de boa-fé.
- **Auditorias e resposta a incidentes:**
  - docs/security-audit-2026-10-18.md e docs/security-audit-2026-10-28.md (auditorias internas);
  - docs/incident-response.md (plano de resposta, item 508 [SG4]);
  - CodeQL e Dependabot de segurança (508 [SG4], parte 1).
- **Não há SECURITY.md na raiz** do repositório.
- **Custos fixos da LLC** (lib/llc-fixed-costs.ts): ainda não têm linha de recompensa de segurança, e os tetos de todas as linhas estão `null` (desconhecido).

Hoje existe, portanto, um **canal de relato sem recompensa** (uma "política de divulgação de vulnerabilidades" simples), mas sem regras publicadas de escopo, prazo e proteção a quem relata.

## 4. Caminhos e custos

| Caminho | Custo fixo | Custo por achado | Origem | O que exige |
| --- | --- | --- | --- | --- |
| **HackerOne** | Não publicado: preço por cotação | Recompensa definida pelo programa + taxa da plataforma sobre os pagamentos (estimativas de 5% a 20%) | **terceiros** (comparadores). Estimativas de US$ 8.000 a 12.000/ano para canal sem recompensa e US$ 25.000 a 100.000/ano para programa privado pago, em conflito entre si | Contrato após cotação (contato com terceiro: decisão do dono) |
| **Bugcrowd** | Não publicado | Recompensa + taxa | **terceiros**: estimativas de US$ 30.000 a 75.000/ano para programa privado | Contrato após cotação |
| **Intigriti** | Não publicado: a página de preços mostra os planos Core, Premium e Enterprise **sem valores**, com limites (Core: até 5 programas; triagem sem limite) | Recompensas à parte | **trecho oficial** (intigriti.com/pricing), sem valores; **terceiros**: mediana de cerca de US$ 42.500/ano, com contrato mínimo de 1 ano | Contrato anual após cotação |
| **YesWeHack** | Não publicado | Recompensas à parte | **terceiros**: sem valor confiável | Contrato após cotação |
| **Programa próprio** (security.txt + página de regras) | Tempo de triagem e conferência: o dono não quer trabalho manual nem painel. O custo de pessoa é **desconhecido** | Tabela própria por gravidade, até o teto | nenhuma fonte externa | Forma de pagamento da LLC, formulários fiscais e checagem de sanções (item 5) |

Conclusão sobre as plataformas: **nenhuma das quatro publica preço**. Todas exigem cotação, ou seja, contato comercial, que é decisão do dono, e as estimativas de terceiros ficam na casa de dezenas de milhares de dólares por ano. Antes da abertura e sem receita, isso pesaria inteiro nos custos fixos (100% Marktmorgen, FX275) e elevaria a base mínima de clientes.

## 5. Programa próprio: o que teria de ser verdade antes de pagar o primeiro centavo

1. **Escopo:**
   - Vale só o que for testado na própria conta e loja do pesquisador, com dados sintéticos.
   - Fica de fora:
     - testar contra dados reais de clientes;
     - engenharia social;
     - negação de serviço;
     - testes físicos;
     - falhas de terceiros (Stripe, Vercel, Upstash, Resend, SES), que vão aos programas deles.
2. **Divulgação responsável:**
   - prazo para resposta e correção antes de o pesquisador publicar;
   - proteção legal ("safe harbor") a quem segue as regras de boa-fé, num texto que o dono aprova;
   - sem acordo de sigilo imposto.
3. **Tabela por gravidade** (proposta para o dono decidir, não aprovada): baixa US$ 50; média US$ 250; alta US$ 1.000; crítica US$ 3.000. Um relato repetido ou já conhecido não paga.
4. **Teto antes do gasto** (regra MR), fixado antes de abrir:
   - teto mensal e teto anual;
   - quando o teto do mês acaba, a página diz isso, e os relatos continuam aceitos sem recompensa até o mês virar;
   - nunca "pagaremos depois" sem dinheiro reservado.
   - Exemplo para a decisão do dono: **US$ 500/mês e US$ 3.000/ano**. Pior caso no ano = **US$ 3.000**, mais a taxa do meio de pagamento, ainda desconhecida.
5. **Triagem sem trabalho manual do dono:**
   - recebimento automático, com confirmação ao pesquisador;
   - fila;
   - reprodução por um agente, só em ambiente sintético, nunca em dados reais.
   - A decisão de pagar depende de uma regra escrita e de uma revisão independente, como as duas revisões que o repositório exige quando sai dinheiro.
6. **Pagamento e impostos:**
   - Sai da LLC, nunca de conta de criador ou de cliente.
   - Meio de pagamento: a conta de pagamento da própria LLC (por exemplo PayPal ou transferência). Abrir ou usar essa conta é decisão do dono.
   - Formulários: W-9 de pesquisador americano e W-8BEN de estrangeiro.
   - Form 1099-NEC para pagamentos de **US$ 2.000 ou mais** no ano a pessoa americana, desde 2026 (antes, US$ 600; One Big Beautiful Bill Act).
     - Fonte: **terceiros** (contadores e softwares fiscais). A página do IRS não foi lida: **lacuna**.
   - Retenção na fonte sobre estrangeiro: não verificada: **lacuna**.
   - No Brasil, pela política TX, o pagamento é despesa da LLC e reduz o lucro sobre o qual incide o IRPF de 15%. Este estudo não altera nenhuma leitura tributária.
7. **Sanções (OFAC):**
   - Não achei orientação oficial da OFAC específica sobre recompensas de segurança.
   - As plataformas retiveram pagamentos a pesquisadores em regiões sob sanção em 2022 (notícias, **terceiros**).
   - Pela leitura mais prudente, pagar a pessoa ou região sob sanção é proibido. Por isso, checar a pessoa contra a lista SDN antes de pagar seria obrigatório. A ferramenta e o seu custo são **desconhecidos**: **lacuna**.

### Onde o custo entra (MR)

- O teto anual entra **inteiro nos custos fixos da LLC** (lib/llc-fixed-costs.ts), como uma linha nova com valor e fonte, e portanto na **base mínima de clientes pagantes**.
- Ele não entra no custo por cliente, porque não varia com o uso de cada um.
- Efeito na base mínima = teto anual (mais as taxas de pagamento e a checagem de sanções, desconhecidas) ÷ a contribuição líquida anual de um cliente pagante, calculada pelo código de margem. O estudo não calcula esse número: não certifica margem nem lucro, e os custos desconhecidos, pela regra MR, reprovam até ter fonte.
- Com uma plataforma, entra também a assinatura anual (dezenas de milhares de dólares por estimativa de terceiros), o que muda a base mínima muito mais do que o teto das recompensas.

## 6. Riscos

- **Pagar sem teto ou sem regra:** custo sem limite, o que fere a regra MR.
- **Testes em dados reais de clientes:** o escopo e a proteção legal precisam proibir isso com clareza.
- **Volume de relatos fracos ou automáticos:** uma triagem manual consumiria o dono, contra a regra de não ter trabalho manual.
- **Promessa pública:** anunciar recompensa sem dinheiro reservado ou sem regra publicada seria recurso de faz de conta (regra VR).
- **Sanções e impostos:** pagar a pessoa errada ou sem formulário tem consequência legal para a LLC.

## 7. Depende do dono: recomendação única

**Não abrir recompensa paga agora** (antes da abertura das vendas e da base mínima). Fazer só, como item pequeno separado, a melhoria do canal que já existe:
- publicar na página `/platform/security` a política de divulgação responsável, com:
  - o escopo (só a própria conta e loja, dados sintéticos);
  - o prazo de resposta que o código cumpre;
  - a proteção legal a quem relata de boa-fé, em texto que o dono aprova;
  - **sem recompensa em dinheiro**;
- criar o SECURITY.md na raiz, apontando para a mesma política.

Não há custo novo além da página que já existe, e não há contrato.

Reavaliar a recompensa paga **depois da abertura, quando a base mínima for atingida**, por programa próprio com teto. A proposta de partida é US$ 500/mês e US$ 3.000/ano, com a tabela do item 5. Antes de abrir, o programa precisa de:
- linha nova em lib/llc-fixed-costs.ts, com valor e fonte;
- os formulários fiscais e o limite de US$ 2.000 conferidos na página do IRS;
- a checagem de sanções definida;
- a forma de pagamento da LLC decidida pelo dono.

Plataformas (HackerOne, Bugcrowd, Intigriti, YesWeHack) só com uma cotação pedida pelo dono.

Decisão pedida ao dono:
- aceitar ou recusar esta recomendação;
- se aceitar, a política de divulgação e o SECURITY.md entram na fila como item novo;
- os valores do teto e da tabela ficam para a reavaliação depois da abertura.

## 8. Lacunas registradas

1. Nenhuma página oficial das plataformas foi aberta (rede bloqueada). As quatro não publicam preço; as estimativas são de terceiros e conflitam entre si.
2. Formulário 1099-NEC e limite de US$ 2.000 em 2026: só fontes de terceiros; a página do IRS não foi lida.
3. Retenção na fonte sobre pagamento a pesquisador estrangeiro: não verificada.
4. Orientação oficial da OFAC para recompensas de segurança: não encontrada. A ferramenta e o custo da checagem na lista SDN são desconhecidos.
5. Taxas do meio de pagamento da LLC para pesquisadores: desconhecidas.
6. Custo de tempo da triagem e da revisão: desconhecido. A automação pedida não existe.

Para fechar as lacunas, é preciso liberar os sites do IRS, da OFAC (Treasury) e das plataformas nas configurações de rede da sessão e ler cada página. Isso só é necessário quando o dono quiser reavaliar a recompensa paga.
