# Design — Automação de download Suno via Studio (bypass da cota de 60/mês)

## Contexto

Desde 03/09/2026 o Suno conta todo download contra a cota do plano — Premier
(plano do André) tem **60/mês**. O pipeline do Umbra Sessions usa
`tracks_per_video: 8`, então cada vídeo consome 8 downloads: 60 ÷ 8 ≈ 7-8
vídeos/mês de faixa 100% nova, muito abaixo do ritmo quase diário do canal.

André rejeitou reaproveitar faixas entre vídeos (quer sempre conteúdo
original — ver [[feedback_suno_studio_download_ilimitado]]). Validado em
14/09/2026: downloads originados do **Suno Studio** não entram na cota —
confirmado manualmente pelo André (contador de "Downloads" não mudou).

**Fluxo manual validado (5 passos por faixa):**
1. Faixa gerada no Suno → menu → **Open in Studio**
2. **Single-track** ("Use the full mix") — não Multi-track (separa stems,
   custa 50 credits à toa)
3. Dentro do Studio, canto superior direito → **Export → Full Song**
4. Isso só salva na Library (toast "Song Saved!"), não baixa direto
5. **Go to Song** → botão de download normal da página da faixa → esse
   download não conta na cota

8 faixas/vídeo × 5 passos = 40 ações manuais por vídeo. André pediu
automatizar — "quanto mais automático melhor".

## Solução

Script `pipeline/suno_downloader.py`, rodado via Task Scheduler
(`\MusicChannel\SunoDownload`), que replica os 5 passos via `agent-browser`
(CLI de automação de browser já instalado no projeto) para toda faixa nova
da Library do Suno, salvando direto em `data/audio/pending/`.

### Disparo

Task Scheduler, **polling a cada 30 min, 08:00–11:45** (8 execuções),
janela que cobre o horário em que André costuma gerar as faixas no chat do
Suno, terminando antes do `Generate` das 12:00. Preferido a 1 check fixo:
se André atrasar gerar as faixas num dia, ainda pega no próximo dos 8 checks
— mesmo motivo que já moveu o `Generate` de 10:00 para 12:00 (ver histórico
do projeto, corrida do dia 07/09).

### Fluxo por execução

1. Abre a Library do Suno com sessão já persistida
   (`agent-browser --session-name suno open https://suno.com/me`) — sem
   login novo a cada run
2. Lista as faixas da Library (snapshot + refs do agent-browser)
3. Compara contra o ledger local `data/suno_downloaded.json`
   (`{song_id: {title, downloaded_at}}`) — pula quem já foi processado
4. Para cada faixa nova, replica os 5 passos manuais:
   `Open in Studio` → `Single-track` → `Export` → `Full Song` → espera o
   toast "Song Saved" (`wait --text "Song Saved"`) → `Go to Song` →
   `download <sel_do_botão> data/audio/pending/<título_sanitizado>.mp3`
5. Grava o `song_id` no ledger só depois do download confirmado em disco
   (arquivo existe e tamanho > 0) — evita marcar como feito uma faixa que
   falhou no meio
6. 0 faixas novas nesse ciclo → só loga, não manda e-mail (rodar 8x/dia
   silencioso é o esperado, e-mail toda hora viraria ruído)
7. Qualquer erro (sessão expirada, elemento não encontrado, timeout) →
   `pipeline.notifier.notify(..., status="fail")`, mesmo padrão Resend já
   usado no resto do pipeline — não interrompe o `Generate`, que segue lendo
   `data/audio/pending/` normalmente (com o que já tiver baixado até ali)

### Sessão Suno

Login manual **1x só**: `agent-browser` abre o Chrome visível, André loga
no Suno, `agent-browser state save` (ou `--session-name suno`) persiste
cookies/localStorage. Runs seguintes reaproveitam a sessão salva, sem
interação.

Se a sessão expirar (Suno pode deslogar por inatividade — não documentado
quão frequente), a run falha na primeira ação pós-login e cai no alerta por
e-mail do passo 7 — mesmo padrão do `CheckToken`/YouTube: falha vira e-mail,
nunca falha silenciosa.

### Ledger (`data/suno_downloaded.json`)

Único propósito: idempotência entre execuções (não rebaixar faixa já
processada). Formato mínimo:

```json
{
  "song_id_abc123": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:30:00"}
}
```

### Nomeação do arquivo

Título da faixa sanitizado (remover caracteres inválidos de filesystem),
mesma convenção alfabética que `main.py` já usa pra escolher os 8 primeiros
de `pending/` via `sorted()` — sem mudança no resto do pipeline.

## Risco conhecido (aceito)

É automação de UI (clica na interface do Studio), não API oficial do
Suno — não existe API oficial. Se o Suno mudar o layout/fluxo do Studio, o
script quebra até o alerta de erro disparar (não silenciosamente, graças ao
passo 7). Aceitável: é ferramenta pessoal de um pipeline de baixo risco, não
produção com cliente pagante.

Risco secundário: automação repetida do mesmo fluxo pode, em teoria, chamar
atenção de sistemas anti-abuso do Suno — mitigado por rodar só 8x/dia em
intervalos de 30 min (não é scraping em rajada), e por ser a própria conta
paga do André fazendo exatamente o que a conta permite manualmente.

## Fora de escopo

- Não automatizar a geração das faixas no Suno (passo criativo, continua
  manual — só o download muda)
- Não usar API não-oficial de terceiros (revendedores tipo EvoLink) — via
  Studio já resolve sem risco de ToS de conta compartilhada
- Não reaproveitar faixas entre vídeos (decisão explícita do André)
- Não mexer no `main.py`/`Generate` — ele continua lendo `pending/` do jeito
  que já lê hoje, o downloader só alimenta essa pasta mais cedo

## Arquivos afetados

- **Novo**: `pipeline/suno_downloader.py` — script principal
- **Novo**: `data/suno_downloaded.json` — ledger, versionado no git (índice
  pequeno de IDs, ao contrário dos áudios/imagens pesados de `data/scenery/`
  e `data/audio/`, que ficam fora)
- **Task Scheduler**: nova task `\MusicChannel\SunoDownload`, 8 triggers
  (08:00, 08:30, ..., 11:45)
- **Editar**: `README`/doc do projeto se existir, registrando o novo passo

## Testes previstos

1. Rodar manual com 1-2 faixas reais no Suno antes de plugar no Scheduler —
   confirmar visualmente que o contador de "Downloads" do Suno não sobe
2. Ledger evita reprocessar faixa já baixada (rodar 2x seguidas, 2ª vez não
   baixa de novo)
3. Erro simulado (sessão inválida) dispara e-mail via `notifier.py` e não
   derruba o processo com exceção não tratada
4. Arquivo baixado aparece em `data/audio/pending/` com nome sanitizado e
   tamanho > 0 antes do ledger ser atualizado
5. 0 faixas novas → não manda e-mail, só loga
