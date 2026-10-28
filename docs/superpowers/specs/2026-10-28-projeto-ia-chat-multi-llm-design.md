# Projeto IA — Plataforma de Chat Multi-LLM (SaaS)

**Data:** 2026-10-28
**Status:** Design aprovado, aguardando spec de negócio (PDF investidores) antes de virar plano de implementação.

## Visão geral

Ambiente web onde o cliente se conecta e conversa com vários modelos de IA (GPT, Claude,
Gemini etc.) em um só lugar, trocando de modelo por conversa, com histórico, anexos de
arquivo, assistentes pré-configurados (personas) e cobrança por plano + excedente. Equivalente
funcional ao core de chat do Abacus.ai — **não** inclui AutoML, agentes autônomos ou app
builder do Abacus; esses ficam fora de escopo deste ciclo (ver "Fora de escopo").

Produto é SaaS vendido a terceiros, com conta por organização (suporta time/múltiplos
usuários por conta desde o início).

## Escopo do MVP

Incluído:
- Chat multi-modelo com troca de modelo no meio da conversa + histórico por usuário
- Upload de anexo (imagem/PDF/doc) nas mensagens
- Personas (system prompt salvo, pessoal ou compartilhado no org)
- Dashboard de créditos/uso (saldo, consumido, excedente projetado)
- Conta por organização com convite de membros (owner/admin/member)
- Billing híbrido: plano mensal com teto de créditos + excedente cobrado, dois gateways
  (Stripe para cartão, Mercado Pago para Pix)

Fora de escopo (v2+, não faz parte deste spec):
- AutoML / treinamento de modelo próprio
- Agentes autônomos / app builder customizado (os "ChatLLM Apps" do Abacus)
- API pública pro cliente integrar na própria aplicação
- Conversa compartilhada/visível pro org todo (v1 é privada por usuário)

## Arquitetura

```
Cliente (browser)
   │
   ▼
Next.js (Vercel) — App Router, streaming de UI
   │
   ├─ Vercel AI SDK — stream de resposta do modelo pro cliente (SSE), Edge Runtime
   ├─► OpenRouter API — roteia pra GPT/Claude/Gemini/etc, uma chave só
   ├─► Supabase
   │     ├─ Postgres — orgs, membros, conversas, mensagens, personas, usage_events, carteira
   │     ├─ Auth — login/signup, sessão
   │     └─ Storage — anexos de mensagem
   └─► Billing
         ├─ Stripe — assinatura (cartão, auto-recorrente) + usage billing de excedente
         └─ Mercado Pago — Pix, cobrança recorrente manual (ver seção Billing)
```

RLS no Postgres isola todo dado por `org_id`; nenhuma query de aplicação precisa filtrar
manualmente.

**Por que agregador (OpenRouter) em vez de integrar cada provedor direto:** uma API, um
formato de billing, catálogo de 100+ modelos, troca de modelo sem mudar código de
integração. Custo: markup pequeno (~5%) do agregador, aceito em troca de zero manutenção
de N integrações.

## Modelo de dados

```sql
organizations   (id, name, plan_id, credit_balance_cents, created_at)
org_members     (org_id, user_id, role: owner|admin|member)
org_invites     (id, org_id, email, role, token, expires_at)
subscriptions   (org_id, gateway: stripe|mercadopago, gateway_ref_id, status: active|past_due|suspended,
                 plan_id, current_period_end, grace_until)
usage_events    (id, org_id, user_id, conversation_id, model_id, tokens_in, tokens_out,
                 cost_cents, is_overage, created_at)
conversations   (id, org_id, user_id, persona_id?, title, model_id, created_at)
messages        (id, conversation_id, role: user|assistant|system, content, created_at)
attachments     (id, message_id, storage_path, mime_type, size_bytes)
personas        (id, org_id, name, system_prompt, created_by, is_shared bool)
plans           (id, name, monthly_credit_cents, allow_overage, price_cents_usd, price_cents_brl)
```

Pontos chave:
- `credit_balance_cents` em `organizations` é a carteira atômica. Toda dedução roda numa
  função Postgres: `UPDATE organizations SET credit_balance_cents = credit_balance_cents - X
  WHERE id = ... AND (credit_balance_cents >= X OR allow_overage)` **na mesma transação**
  que insere em `usage_events` — saldo nunca diverge do ledger de auditoria.
- Conversa é privada ao `user_id` dentro do org. Persona pode ser pessoal ou compartilhada
  (`is_shared=true`, visível pro org todo).
- RLS: toda tabela com `org_id` filtra por
  `org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())`. `messages` e
  `attachments` herdam via join com `conversations`.
- Custo interno guardado em USD cents (é como a OpenRouter cobra); exibido convertido em
  BRL pra cliente BR no dashboard.

## Fluxo de chat

1. Usuário abre conversa (nova ou existente), escolhe modelo no seletor (catálogo vem do
   OpenRouter, preço/token exibido).
2. Envia mensagem (texto + anexo opcional). Anexo sobe pro Supabase Storage primeiro;
   mensagem referencia `storage_path`.
3. Checa `credit_balance` do org antes de chamar o modelo: bloqueia se zerado e plano não
   permite excedente; senão permite e marca `is_overage=true` no evento.
4. Chama OpenRouter com histórico da conversa + system prompt da persona (se houver) +
   anexo, se o modelo escolhido aceitar o tipo (UI avisa antes de enviar se não aceitar).
5. Resposta em stream via SSE (Vercel AI SDK `useChat`).
6. Ao fechar o stream: grava `usage_events` (tokens reais retornados pela OpenRouter) +
   deduz carteira, na mesma transação. **Só cobra em sucesso** — chamada que falhou não
   debita crédito.
7. Troca de modelo no meio da conversa é só mudar `model_id` da próxima mensagem; histórico
   e contexto continuam normais.

Tratamento de erro: OpenRouter fora do ar/rate limit → retry com backoff, mensagem clara,
sem cobrança. Anexo não suportado pelo modelo → bloqueia no client antes de enviar. Limite
de contexto excedido → trunca histórico mais antigo, avisa usuário.

## Billing e créditos (dual-gateway)

**Stripe (cartão):** webhook-driven, automático. `invoice.paid` recarrega a carteira (reset
mensal, não acumula); `invoice.payment_failed` marca `past_due`, mesma régua de carência do
Pix (7 dias) antes de suspender. Excedente, se o plano permitir, vira Stripe Usage Record
(metered billing) cobrado na fatura seguinte.

**Mercado Pago (Pix):** Pix não tem cobrança recorrente automática real (diferente de
cartão tokenizado) — o fluxo é cobrança recorrente manual disfarçada de assinatura:
- Cron diário varre `subscriptions` com `gateway=mercadopago`.
- 3 dias antes de `current_period_end`: gera novo Pix (QR + copia-e-cola), notifica
  cliente, status `pending_renewal`.
- Pago (webhook MP confirma) → recarrega carteira, avança `current_period_end` em 1 mês,
  status volta `active`.
- Não pago até `current_period_end` → `grace_until = current_period_end + 7 dias`, lembrete
  enviado.
- Não pago até `grace_until` → `status = suspended`: chat bloqueado, histórico e dashboard
  continuam acessíveis, banner de renovação.

Regras já validadas em outros projetos do André que se aplicam aqui: QR do Pix sempre na
tela (nunca só por e-mail), e-mail do pagador no MP é caixa própria da empresa (não o
e-mail do cliente, que fica só no cadastro pra contato).

## Auth, time e anti-abuso

- Supabase Auth (e-mail+senha e/ou Google OAuth). Primeiro login cria `organizations` +
  `org_members(role=owner)`.
- Convite de membro: owner/admin manda convite por e-mail (`org_invites`), link único,
  signup/login vincula ao org.
- Rate limit por requisições/minuto por org (Vercel Edge Middleware ou Upstash Redis),
  configurável por plano — protege contra 1 usuário gerando excedente gigante antes do
  cliente perceber, complementa (não substitui) o limite de crédito.

## Testes e critério de pronto

- **Unit:** dedução de carteira (transação atômica, não diverge do ledger, respeita
  `allow_overage`).
- **Integration:** fluxo de chat completo (mock OpenRouter) cobrando só em sucesso; webhook
  Stripe/MP atualizando `subscriptions` e recarregando carteira; RLS comprovando isolamento
  entre orgs (teste automatizado, não só manual).
- **E2E:** signup → cria org → manda mensagem → troca modelo → upload de anexo → dashboard
  de créditos atualiza.
- **Critério de pronto do v1:** cliente paga (Stripe ou Pix), conversa com pelo menos 3
  modelos diferentes via OpenRouter, saldo/créditos corretos no dashboard, suspensão por
  não-pagamento funciona nos dois gateways, RLS isola org comprovadamente.

## Riscos conhecidos

- Pix "recorrente" depende de ação manual do cliente a cada ciclo — taxa de churn
  involuntário (esquecimento) provavelmente maior que cartão. Vale medir após lançamento.
- Preço de modelo na OpenRouter pode mudar sem aviso — `plans.monthly_credit_cents` precisa
  de margem de segurança sobre o custo médio estimado, não custo mínimo.
- Dois gateways de billing desde o v1 é mais superfície de bug do que só Stripe; decisão
  consciente porque Pix é requisito de negócio, não técnico.
