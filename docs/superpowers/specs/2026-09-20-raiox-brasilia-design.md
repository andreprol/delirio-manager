# RaioX Brasília — Design v1

## Contexto e objetivo

Site institucional de consulta pública: busca um político/candidato brasileiro (por nome, código de candidato TSE ou partido) e recebe uma ficha única com toda informação disponível sobre ele, cada dado com fonte e data de coleta explícitas ao lado.

Diferencial de posicionamento: não é site de notícia (Congresso em Foco, Aos Fatos) nem só cadastro de candidato (portal do próprio TSE). É dossiê por pessoa — busca uma vez, recebe tudo. Mais perto do formato "Excelências" (Transparência Brasil) ou "OpenSecrets" (EUA), mas nenhum concorrente brasileiro junta candidatura + financiamento + votação + processo + apoio formal numa página só.

## Decisão de arquitetura institucional (resolvida antes do design técnico)

Proposta original incluía hospedagem em blockchain (Stellar) e domínio estrangeiro, com objetivo explícito de tornar o site resistente a ordens judiciais de remoção no Brasil. Essa direção foi descartada por dois motivos, discutidos e acordados com o usuário:

1. **Técnico**: Stellar não é plataforma de hospedagem de conteúdo (é rede de pagamento/ativos); mesmo com hospedagem estrangeira, o Judiciário brasileiro já demonstrou capacidade de bloquear acesso a sites/plataformas inteiras via ISP dentro do país (caso X/Twitter, 2024), independente de onde o servidor está.
2. **Ético/legal**: o projeto vai cumprir ordem judicial válida caso ela ocorra. Resiliência técnica (ex: storage descentralizado, se necessário no futuro) serve para integridade/uptime do arquivo, nunca para tornar uma decisão judicial inexequível.

Decisão final: **domínio nacional (registro.br)**, hospedagem convencional (Vercel), sem blockchain. Mecanismo de conformidade com ordem judicial faz parte do design (ver Seção 5).

## Escopo v1

**Cargos cobertos**: presidente, vice-presidente, governador, vice-governador, senador, deputado federal, deputado estadual/distrital — todo cargo não-municipal. Vereador e prefeito ficam para versão futura (dado municipal é fragmentado, sem API unificada).

**Profundidade histórica**: carreira completa do político, não só o ciclo eleitoral atual — todas as candidaturas e mandatos desde que o TSE tem dado estruturado (aproximadamente 1994-1996 em diante, a confirmar por cargo durante implementação).

**Pilares de dado no v1** (todos com fonte oficial primária, pipeline automatizado, sem curadoria manual):

1. Candidatura e financiamento de campanha — fonte TSE.
2. Votação nominal no legislativo (só para quem foi deputado federal/estadual ou senador) — fonte Câmara dos Deputados / Senado Federal.
3. Processos judiciais — fonte CNJ DataJud, excluindo automaticamente qualquer processo em segredo de justiça.
4. Apoio formal — coligação (mesma chapa eleitoral) e doação de campanha entre candidatos/comitês — fonte TSE.

**Explicitamente fora do v1** (ficam para v2 ou versões futuras):

- Escândalos políticos — depende de fonte jornalística e curadoria manual, exige revisão jurídica caso a caso antes de publicar (risco de difamação). Não entra até haver processo editorial testado.
- Apoio informal / declaração pública de apoio entre políticos — mesma razão acima.
- Cobertura municipal (vereador, prefeito).
- Blockchain, hospedagem fora do Brasil.
- Conta de usuário, favoritos, comparação lado a lado entre políticos, alertas por e-mail — não solicitado, não faz parte do v1.

## Arquitetura técnica

- **Repositório**: novo, `F:\RichClub\raiox-brasilia`, git próprio.
- **Frontend**: Next.js (App Router), páginas de ficha renderizadas no servidor (SEO é o principal canal de descoberta — busca por nome de candidato).
- **Banco de dados**: Postgres via Supabase — mesmo padrão usado em outros projetos do usuário (CV Tailor, Uriverse3D).
- **Ingestão de dados**: scripts de robô (Node/TypeScript; Python pontualmente se o tratamento de dado histórico do TSE exigir, sem virar sistema separado), agendados:
  - TSE: semanal (dado muda pouco fora de retificação de conta).
  - Câmara/Senado: diário (sessão legislativa quase todo dia).
  - CNJ DataJud: diário (movimentação processual).
- **Deploy**: Vercel (frontend), domínio via registro.br apontado por registro A no apex, seguindo o mesmo cuidado já usado em outros projetos do usuário para não quebrar e-mail existente.

## Modelo de dado (entidades principais)

- `pessoa` — identidade única do político ao longo do tempo (nome, CPF, data de nascimento). Chave usada para unir candidaturas de anos diferentes na mesma ficha. CPF é usado apenas internamente para cruzamento; nunca exibido na interface.
- `candidatura` — um registro por (pessoa, ano eleitoral, cargo): número, partido/coligação, situação (eleito, não eleito, cassado etc.), UF. Fonte: TSE.
- `financiamento` — receita e despesa de campanha ligada a uma candidatura. Fonte: TSE (prestação de contas).
- `mandato` — período de exercício efetivo, derivado de candidatura eleita, usado para associar a votação correta.
- `votacao` — um registro por (mandato, proposição): como o parlamentar votou. Fonte: Câmara/Senado.
- `processo` — um registro por (pessoa, número CNJ): tribunal, assunto, status. Fonte: CNJ DataJud. Processos sigilosos são excluídos no momento da ingestão, não apenas ocultados na tela.
- `apoio_formal` — coligação (candidaturas na mesma chapa) e doação de campanha entre pessoa/comitê. Fonte: TSE.

Toda linha de toda tabela de dado carrega `fonte_url` e `coletado_em`, usados para exibir "fonte: [link], atualizado em [data]" ao lado de cada informação na ficha.

**Risco técnico identificado**: cruzar a mesma pessoa entre candidaturas de anos diferentes depende de casar CPF (ou nome + data de nascimento) entre arquivos do TSE cujo formato mudou ao longo de três décadas. Este ponto será validado no início da implementação; caso o cruzamento falhe para algum período, a candidatura daquele ano permanece separada (com aviso) em vez de o sistema inventar um vínculo.

## Site — busca e ficha

**Busca** (home): campo único aceitando nome (parcial, sem diferenciar acento), número de candidato ou partido. Resultado em lista (foto, nome, cargo mais recente, partido, UF), levando à ficha individual. Implementada via busca textual do Postgres.

**Ficha do político**, estrutura de cima para baixo:

1. Cabeçalho — foto (TSE), nome, cargo atual/mais recente, partido, UF, situação.
2. Candidaturas — linha do tempo de todas as candidaturas, cargo e resultado.
3. Financiamento de campanha — por candidatura: receita total, principais doadores, despesas.
4. Votações — presente apenas se a pessoa já foi deputado ou senador; lista de proposições com filtro interno (pode haver centenas por mandato).
5. Processos judiciais — tribunal, assunto, status.
6. Apoios formais — coligação e doações de campanha, em ambas as direções (doou/recebeu).

Seções sem dado disponível não desaparecem — exibem explicitamente "sem [dado] registrado", deixando claro que a ausência foi verificada, não é uma falha de carregamento.

URLs amigáveis (`/politico/nome-slug`), sitemap gerado automaticamente para indexação.

## Conformidade e casos de erro

- **Fonte oficial indisponível ou com formato alterado**: o robô registra o erro e mantém o último dado válido já coletado, sinalizando a data da última atualização bem-sucedida — nunca remove dado por falha temporária de coleta.
- **Homônimos**: desambiguação interna por CPF e código TSE; nunca dois registros de pessoas diferentes são mesclados por coincidência de nome.
- **Divergência entre fontes** (ex: TSE e Câmara descrevem o mesmo mandato de forma diferente): ambas as versões são exibidas com sua respectiva fonte, sem escolha silenciosa de uma sobre a outra.
- **LGPD**: apenas dado que já é público por natureza da função (candidatura e mandato de agente público/candidato são de interesse público). Nenhum dado de contato pessoal (endereço, telefone) é exibido, mesmo que presente na base de origem.
- **Canal de correção**: disponível na ficha desde o v1, para contestação de dado incorreto (ex: processo de homônimo, erro de fonte).
- **Cumprimento de ordem judicial**: nenhum registro é apagado do banco de dados por ordem judicial — é marcado internamente como "oculto por ordem judicial nº X" (com referência ao processo) e deixa de ser exibido publicamente. O dado permanece auditável internamente; a remoção pública é efetiva e imediata.

## Teste e verificação

O risco principal não é lógica de programação complexa, é dado batendo com a fonte oficial. Testes focam em:

- Robô de ingestão validado contra político de amostra com resultado público conhecido.
- Cruzamento de identidade entre anos não pode unir pessoas diferentes (teste anti-falso-positivo).
- Processo em segredo de justiça nunca aparece na ficha (teste de filtro).
- Nenhuma seção é publicada sem `fonte_url` e `coletado_em` associados.
- Antes do lançamento: conferência manual da ficha de 20-30 políticos conhecidos (mistura de partidos e níveis de notoriedade) contra a fonte oficial correspondente.

## Fora de escopo (confirmado)

Escândalo político, apoio informal, cobertura municipal, blockchain, hospedagem fora do Brasil, conta de usuário, favoritos, comparação entre políticos, alertas por e-mail. Nenhum desses itens faz parte do v1.
