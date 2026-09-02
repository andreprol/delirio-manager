# Uriverse3D — Fundação + Loja (Storefront) — Design

**Data:** 2026-09-02
**Status:** Aprovado pelo André, pendente de plano de implementação
**Sub-projeto:** 1 de 4 (Fundação + Loja). Os demais — Admin, IA de Fotos, Notificações/LGPD — têm spec própria, construída depois.

## Contexto do negócio

- **Domínio:** uriverse3d.com.br (já adquirido). E-mail oficial: contato@uriverse3d.com.br. DNS hoje na Hostgator, será migrado (site) para Vercel ou outro host — e-mail deve continuar funcionando (MX preservado).
- **Empresa responsável:** Software Innovations e Tecnologia LTDA (ex-EIRELI), CNPJ 28.481.336/0001-32, ME, sede Av. Vice Presidente José Alencar 1400 bl.004 apt.406, Jacarepaguá, RJ. Titular: Raquel Pires Serpa.
- **Produto:** e-commerce de itens 3D-printados voltados ao universo K-pop/army/dorama, autorais da Raquel (mesma marca dos canais YouTube/Instagram dela já geridos no projeto YouTube).
- **Modelo de produção:** sem estoque. Todo produto — catálogo ou personalizado — é produzido **depois** do pedido pago. Prazo padrão: 5 dias úteis por produto (configurável por produto).
- **Escala inicial:** ~50 produtos no catálogo, arquitetura deve escalar sem redesenho de schema.
- **Origem de envio:** CEP 22790-672 (Rio de Janeiro/RJ).
- **Administradores:** André e Raquel, ambos admin completo (sem hierarquia de papéis).
- **Referência visual:** annyeongchingubox.com.br — simplicidade e identidade visual como norte, sem copiar.
- **Sem página institucional** — é só o e-commerce (catálogo, carrinho, checkout, orçamento).

## Decisão de arquitetura

**Stack escolhida: Next.js (App Router) + Vercel + Supabase (Postgres + Storage + Auth) + Mercado Pago + Melhor Envio + Resend.**

Avaliadas 3 opções:

| Opção | Prós | Contras | Decisão |
|---|---|---|---|
| **A — Next.js/Vercel/Supabase custom** | Controle total sobre admin com relatórios, fila de produção e fluxo de orçamento (requisitos específicos do negócio); mesmo padrão dos outros projetos RichClub | Mais trabalho de construção inicial | **Escolhida** |
| B — WordPress + WooCommerce | Rápido de montar, plugins BR prontos | Fila de produção/relatórios customizados exigem gambiarra; admin genérico | Descartada |
| C — Shopify | Fácil de usar | Mensalidade + apps pagos por customização; toggle de orçamento e fluxo LGPD específico não encaixam nativamente | Descartada |

**Pagamento — Mercado Pago** (Pix ~0,99%, cartão ~4,99%, checkout transparente embutido, menor barreira de entrada para ME nova, webhook de confirmação). Alternativas avaliadas: Pagar.me/Stone (só compensa em alto volume >R$100k/mês), Stripe (Pix ainda não nativo como no ecossistema BR).

**Frete + etiqueta — Melhor Envio** (grátis, sem mensalidade, cálculo automático via CEP, emite etiqueta Correios + transportadoras sem contrato próprio necessário). Alternativa avaliada: Frenet (plano pago ~R$67/mês pra liberar mais transportadoras).

**E-mail transacional — Resend**, domínio uriverse3d.com.br verificado (necessário para enviar a destinatários além da conta própria).

## Modelo de dados (fundação)

- **Product** — nome, slug, descrição, categoria (temática), preço base, peso/dimensões (frete), prazo de produção (padrão 5 dias úteis, sobrescrevível por produto), fotos (original + versão tratada por IA — pipeline de tratamento é sub-projeto separado), variações (cor/tamanho, campo JSON flexível para não exigir redesenho de schema ao escalar), status (ativo/rascunho).
- **Order** — cliente, itens, endereço de entrega, frete escolhido, status de pagamento (pendente/pago/estornado), status de produção (fila → em produção → pronto → enviado → entregue), código de rastreio, valor total, tipo (padrão vs. personalizado).
- **CustomQuoteRequest** — separado de Order. Cliente, descrição, foto de referência, canal (site ou WhatsApp), status (pendente/orçado/aceito/recusado), preço proposto pela Raquel. Vira Order somente quando aceito e pago.
- **Customer** — dados mínimos por LGPD by design (nome, e-mail, endereço; CPF somente se exigido para nota fiscal), campo de consentimento com timestamp (evidência LGPD).
- **AdminUser** — André e Raquel, role única (admin completo).
- **SiteSettings** — flags globais, incluindo o toggle liga/desliga do formulário de encomenda personalizada no site. O botão de WhatsApp permanece sempre visível e fora desse controle (não há como restringir o que chega por lá).

## Loja (Storefront)

- **Catálogo:** grid por categoria/tema, busca simples, paginado — escalável de 50 a milhares de produtos sem redesenho.
- **Página de produto:** fotos tratadas, descrição, variações, prazo de produção visível ("pronto em N dias úteis").
- **Carrinho → Checkout:** CEP do cliente → cálculo de frete automático (Melhor Envio, origem 22790-672) → escolha de transportadora/prazo → pagamento (Mercado Pago Checkout Transparente: Pix ou cartão, embutido, sem redirecionamento) → confirmação.
- **Encomenda personalizada:** rota visível apenas quando o toggle em SiteSettings está ligado. Formulário (descrição + upload de foto de referência) cria um CustomQuoteRequest. Paralelamente, botão de WhatsApp sempre disponível, sem controle de disponibilidade — canal informal e sem filtro, aceito como tal.

## Fluxo de e-mails automáticos (Resend)

1. Pedido confirmado (pagamento aprovado via webhook Mercado Pago) — também dispara entrada automática na fila de produção.
2. Pedido em produção.
3. **Pedido enviado — com código de rastreio** (disparado quando `Order.status` muda para "enviado" e o campo `rastreio` é preenchido).
4. Pedido entregue (se a transportadora informar o evento).
5. Alertas internos (nova venda, nova mensagem de orçamento, atraso de produção) para contato@uriverse3d.com.br + lista de e-mails adicionais configurável (gerenciamento da lista fica no sub-projeto Admin; o modelo de dados já suporta).

## Segurança / LGPD (base para este sub-projeto)

- Senha de cliente sempre com hash, nunca texto puro.
- HTTPS obrigatório (garantido pela Vercel).
- Coleta de dado mínimo — sem campo supérfluo, CPF só quando exigido para nota fiscal.
- Consentimento registrado com timestamp no cadastro (evidência para LGPD).
- Modelo já preparado para soft-delete + anonimização de Customer — o fluxo completo de solicitação/confirmação de exclusão de conta é do sub-projeto "Notificações/LGPD", tratado separadamente.

## Testes

- **Unitário:** cálculo de frete, transições de status de pedido, validação do formulário de orçamento.
- **Integração:** webhook do Mercado Pago (simulado/sandbox), fluxo carrinho → checkout → pedido criado.
- **Manual (navegador):** fluxo completo de compra ponta a ponta antes de qualquer publicação em produção.

## Fora de escopo deste spec (sub-projetos futuros)

- **Admin:** cadastro de produto pela UI, relatórios (vendas, produtos mais vendidos, logística/atrasos, produção pendente), gestão da lista de e-mails de alerta, aceite/precificação de orçamento, emissão de etiqueta pela UI.
- **IA de fotos:** pipeline de tratamento de foto amadora → foto profissional de produto.
- **Notificações/LGPD:** fluxo completo de exclusão de conta a pedido do cliente (link + evidência), outras etapas de notificação de percurso do pedido além do rastreio.
