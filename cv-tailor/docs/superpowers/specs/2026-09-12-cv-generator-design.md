# CV Tailor — Fase 1: Motor de Geração + Rastreador (design)

Data: 2026-09-12
Status: aprovado por André, pronto pra virar plano de implementação

## Contexto e evidência

André se candidata a vagas remotas internacionais (foco atual: Technical Program Manager / AI Product
Strategy; foco original em paralelo: Web3 Developer / Soroban Developer) e relata zero entrevista em
dezenas de candidaturas feitas sozinho, todas travando "no robô" (ATS).

Investigação nesta sessão (pesquisa profunda com 7 agentes, 95 buscas + auditoria do CV real
`CV_Andre_Prol_TCS_AI_TPM.pdf`) confirmou parcialmente a hipótese:

- O mito "ATS rejeita tudo sem revisão humana" é majoritariamente falso (Greenhouse: 100% scorecard
  humano; só ~8% dos recrutadores relatam auto-rejeição fora de pergunta eliminatória).
- O que É real e bate direto no caso do André:
  1. **Título exato da vaga no CV é o fator mais determinante de match** (até 10,6x mais chance de
     entrevista — Jobscan). O CV do André usa sempre o mesmo headline genérico pra toda vaga.
  2. Header do PDF atual é um bloco de cor sólida (visual de text box) — texto em text box é
     frequentemente pulado inteiro pelo parser (RChilli/Daxtra, documentação oficial de vendor).
  3. Seção de projetos é uma tabela com borda — tabela é a causa nº1 de erro de parsing relatada por
     clientes enterprise (mesmas fontes).
  4. Checkmarks/setas unicode nos bullets — risco menor, mas real em ATS mais rígido (Taleo).
  5. Se o mesmo CV (100% TPM, zero keyword de blockchain/Web3/Solidity/Soroban/Stellar) ainda for usado
     pra vaga Web3 Developer: mismatch total, descarte garantido tanto pra parser quanto pra humano.
- Lacuna adicional: não havia (antes desta sessão) nenhum registro estruturado de quais vagas foram
  aplicadas, com qual CV, e qual foi o resultado — impossível medir taxa de resposta real.

Full findings + fontes: memória de sessão do projeto (`project_web3_emprego.md`, seção "Sessão
2026-09-11 — Investigação ATS").

## Objetivo da Fase 1

Ferramenta com interface web (não mais um comando/skill do Claude Code) que:
1. Mantém um banco de dados mestre das conquistas/métricas reais do André, tagueadas por
   posicionamento (`TPM`, `AI Product`, `Web3`).
2. Gera, por vaga específica, um CV ATS-safe por construção (não por prompt torcendo os dedos) que
   espelha título/keywords exatos da vaga.
3. Gera também as perguntas prováveis de entrevista pra aquela vaga.
4. Registra cada candidatura formal (vaga + CV usado + status) de forma pesquisável, fechando o loop
   de medição que faltava.

Fora de escopo nesta fase (fica pra fase 2, só se a fase 1 validar valor): login/conta de terceiros,
cobrança, multi-usuário real, export em PDF, scraping robusto anti-bot de LinkedIn.

## Arquitetura

- **Next.js (App Router)**, hospedado na **Vercel** — mesma linha de Uriverse3D/Revivio.
- **Supabase Postgres** para todos os dados (banco mestre, candidaturas, versões de CV, perguntas de
  entrevista) + **Supabase Storage** pros arquivos `.docx` gerados.
- **Claude API (Anthropic)** chamada só em server actions/rotas — nunca client-side, chave nunca
  exposta ao navegador.
- **Biblioteca `docx` (Node)** pra renderizar o arquivo final a partir de um template determinístico —
  a IA nunca "escreve o arquivo", só devolve conteúdo estruturado (JSON) que o código injeta num
  template fixo: coluna única, bullets ASCII, sem tabela, sem text box, sem símbolo unicode. Isso
  trava por construção os 3 problemas técnicos achados na auditoria — não depende do modelo "lembrar"
  de seguir a regra toda vez que gera.
- RLS do Supabase fica desligada/permissiva na fase 1 (só existe 1 usuário), mas todo dado já nasce com
  `user_id` — ativar RLS de verdade na fase 2 não exige migração de schema. Nota pra fase 2: testar RLS
  com anon key de verdade antes de confiar nela (ver `feedback_rls_e_comportamento_nao_so_seguranca` e
  `feedback_rls_policy_nao_protege_coluna` na memória — já mordeu o André antes no Uriverse3D).

## Componentes

1. **Banco mestre** — tabelas `achievements`, `education`, `certifications`, `skills`, `profile`.
2. **Importador inicial** (rotina one-shot) — lê os PDFs de CV existentes do André, extrai
   achievement/formação/skill estruturado via Claude, grava como rascunho pra revisão antes de
   confirmar. Roda uma vez, não é parte do fluxo recorrente do produto.
3. **Ingestão de vaga** — formulário com campo de link (tenta extrair texto automaticamente via fetch +
   parsing simples de HTML — sem headless browser, sem anti-bot dedicado; sites que bloqueiam, como
   LinkedIn tende a fazer, caem direto no fallback) e campo de texto colado (fallback manual, sempre
   disponível). Texto extraído é mostrado pra conferência antes de prosseguir — scraping pode vir sujo.
4. **Motor de geração** — server action: monta prompt com banco mestre completo + vaga, chama Claude,
   recebe JSON estruturado (achievements escolhidos, resumo customizado, headline espelhando o título
   exato da vaga, keywords identificadas, lista de perguntas prováveis de entrevista com o porquê de
   cada uma).
5. **Renderizador DOCX** — injeta o JSON no template fixo, sobe o arquivo pro Storage.
6. **Dashboard** — lista de candidaturas com busca full-text (vaga/empresa/status); cada candidatura
   abre vaga original, CV gerado (download), perguntas de entrevista, status editável.

## Modelo de dados

- `profile` — dados de contato, headline por posicionamento, `user_id`.
- `achievements` / `education` / `certifications` / `skills` — banco mestre; cada linha com tag de
  posicionamento (`TPM` | `AI Product` | `Web3`, pode ter mais de uma) e `user_id`.
- `applications` — `job_description_raw`, `source_url` (nullable), `company`, `role_title`, `created_at`,
  `status` (`sem_resposta` | `rejeitado` | `entrevista` | `oferta`), `user_id`. Full-text search
  (Postgres `tsvector`) sobre vaga/empresa/cargo.
- `cv_versions` — 1:1 com `applications`; `storage_path` do `.docx`, JSON gerado (achievements
  escolhidos, resumo, keywords).
- `interview_questions` — N:1 com `applications`; pergunta + porquê.

## Fluxo

1. André abre o app → "Nova candidatura" → cola link ou texto da vaga.
2. Se link: sistema tenta extrair texto → mostra o texto extraído pra conferência antes de prosseguir.
3. "Gerar CV" → server action chama Claude com banco mestre + vaga → recebe JSON → renderiza DOCX →
   sobe pro Storage → grava `applications` + `cv_versions` + `interview_questions`.
4. Tela de resultado: preview do conteúdo em texto, botão de download do `.docx`, lista de perguntas de
   entrevista prováveis.
5. Envio da candidatura continua manual, fora do sistema (LinkedIn/site da empresa). André volta depois
   só pra atualizar `status`.

## Tratamento de erro

- Scraping falha (bot bloqueado, site pesado em JS) → fallback pedir texto colado manual; nunca trava
  o fluxo.
- Claude devolve JSON incompleto/malformado → 1 retry automático; falhando de novo, erro claro na tela
  e edição manual liberada antes de gerar o DOCX. Nunca gera CV incompleto silenciosamente — é
  exatamente a falha silenciosa que a auditoria achou no PDF atual (texto em text box some sem aviso),
  não pode se repetir dentro do próprio sistema.
- Banco mestre sem dado suficiente pra vaga (ex.: vaga Web3 sem nenhum achievement de blockchain) →
  avisa explícito "sem dado suficiente pra essa vaga", nunca inventa conquista falsa.

## Critério de sucesso / medição

- Dashboard mostra taxa de resposta real: candidaturas com `status != sem_resposta` sobre o total,
  contando "sem resposta" só depois de 2-3 semanas da data de envio (evita julgar vaga recente cedo
  demais). Fecha o buraco de medição que motivou toda essa investigação.
- Validação manual do MVP: gerar CV pra 3-5 vagas reais (TPM e, se ainda ativo, Web3), abrir o `.docx`
  resultante e confirmar (selecionar tudo → colar em bloco de notas) que nenhum texto virou lixo —
  teste direto contra os achados da pesquisa ATS.

## Decisões descartadas (com motivo)

- **Artifact hospedado pela Anthropic** (interface + banco embutido): descartado porque o sandbox do
  viewer bloqueia download de arquivo iniciado pela própria página (`.docx` final não sairia de lá) e
  porque expor a lógica de geração exigiria rodar chamada de API com chave fora do controle do André.
- **Airtable/planilha como banco (spike rápido)**: descartado porque André já confirmou ambição de
  produto real — teria que ser refeito na stack final se validar, sem ganho líquido de tempo.
- **PDF como formato de saída da fase 1**: adiado pra fase 2. DOCX sozinho já resolve o caso de uso e
  evita duplicar o trabalho de geração/validação por enquanto.
