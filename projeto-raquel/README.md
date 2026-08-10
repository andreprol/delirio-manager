# Projeto Raquel — Pipeline YouTube K-dramas & Fan Meetings

Canal **Raquel Pires** (@raquelpires) — pipeline de conteúdo para YouTube + blog SEO.

## Visão Geral

Raquel posta no Instagram (@raquelpiiires) sobre K-dramas e fan meetings. Este pipeline pega essas postagens (ou entradas manuais) e gera:

1. **Script do vídeo** — gerado por Claude, tom carioca da Raquel
2. **Descrição do YouTube** — com capítulos, hashtags e CTAs
3. **Artigo de blog SEO** — para ser publicado via Soro IA ou salvo localmente
4. **Upload agendado** — respeita slots horários (12h / 18h BRT)

---

## Status do Projeto (10/08/2026)

| Etapa | Status |
|-------|--------|
| Estrutura técnica e pipeline | ✅ Completo (merged em master) |
| Testes unitários (16 testes) | ✅ Passando |
| Chave Anthropic no `.env` | ⏳ Aguarda André |
| OAuth2 YouTube (`client_secrets.json`) | ⏳ Aguarda André |
| Primeiro vídeo gerado e publicado | ⏳ Próximo passo |
| Integração Soro IA (blog) | ⏳ Ativar depois que o canal decolar |

---

## Setup Inicial (O que André precisa fazer)

### 1. Configurar chave Anthropic

**Importante:** Projeto Raquel usa uma chave Anthropic **própria**, separada do Delirio Manager. São projetos distintos, com orçamentos e limites de uso independentes.

Criar nova chave em [console.anthropic.com](https://console.anthropic.com/) → API Keys → Create Key (nomear como "projeto-raquel").

Editar `projeto-raquel/.env`:
```
ANTHROPIC_API_KEY=sk-ant-xxxxx   # chave exclusiva do Projeto Raquel
```

### 2. Configurar OAuth2 do YouTube

1. Acessar [Google Cloud Console](https://console.cloud.google.com/)
2. No projeto existente (ou criar novo), ativar **YouTube Data API v3**
3. Criar credencial → **OAuth 2.0 Client ID** → tipo: **Desktop app**
4. Baixar o JSON e salvar em `projeto-raquel/config/client_secrets.json`

Na primeira execução do upload, o navegador vai abrir para autorizar. O token fica salvo em `data/token.json` para usos futuros.

### 3. Primeiro uso

```bash
cd projeto-raquel
pip install anthropic python-dotenv pytest   # se ainda não instalado
python main.py add-review                    # criar brief da primeira review
python main.py generate                      # gerar script
python main.py status                        # ver fila
```

---

## Como Usar no Dia a Dia

### Fluxo Completo

```bash
# 1. Criar brief (escolha um):
python main.py add-review       # Review de K-drama
python main.py add-fanmeeting   # Vlog de fan meeting
python main.py add-instagram    # Importar legenda do Instagram

# 2. Gerar script (Claude escreve o roteiro)
python main.py generate

# 3. Revisar o script em data/scripts/<id>.json
#    Editar se necessário, depois:

# 4. Gerar artigo SEO (opcional, para o blog)
python main.py seo <id> https://youtu.be/<video_id>

# 5. Agendar upload
python main.py schedule <id>

# 6. Fazer upload (rodar no horário ou manualmente)
python main.py upload

# Ver status da fila a qualquer momento
python main.py status
```

### Importar do Instagram

Quando Raquel postar no Instagram, copiar a legenda e rodar:
```bash
python main.py add-instagram
# Colar a legenda quando solicitado
# O sistema detecta automaticamente se é review, ranking ou fan meeting
```

---

## Arquitetura

```
projeto-raquel/
├── main.py                    # CLI principal
├── .env                       # Chaves (não comitado)
├── config/
│   ├── channel.json           # Identidade do canal
│   ├── niches.json            # Tipos de conteúdo e triggers
│   ├── schedule.json          # Slots de upload (12h/18h BRT)
│   └── soro.json              # Config integração blog
├── pipeline/
│   ├── content_intake.py      # Intake: Instagram → brief
│   ├── script_generator.py    # Claude → script JSON
│   ├── seo_optimizer.py       # Claude → artigo blog + descrição YouTube
│   ├── blog_publisher.py      # Publica artigo (webhook ou arquivo local)
│   ├── queue.py               # SQLite: briefs + upload_queue
│   └── uploader.py            # YouTube upload (reutiliza youtube-rhetoric-pipeline)
├── prompts/
│   ├── script_review.txt      # Prompt para reviews de K-drama
│   ├── script_fanmeeting.txt  # Prompt para vlog de fan meeting
│   └── blog_article.txt       # Prompt para artigo SEO
├── data/                      # Runtime (não comitado)
│   ├── pipeline.db            # SQLite
│   ├── temp/                  # Vídeos temporários
│   ├── scripts/               # Scripts gerados (JSON)
│   └── articles/              # Artigos salvos localmente
└── tests/
    ├── test_content_intake.py
    └── test_seo_optimizer.py
```

---

## Tipos de Conteúdo

| Tipo | Duração | Evergreen | Gatilhos |
|------|---------|-----------|---------|
| `review` | 8–15 min | Sim | "assisti", "terminei", "drama", "kdrama" |
| `fanmeeting` | 12–20 min | Não | "fan meeting", "fanmeeting", "show", "evento" |
| `ranking` | 6–12 min | Sim | "top", "ranking", "melhores", "favoritos" |
| `short` | 0–1 min | Sim | (entrada manual) |

---

## Integração Soro IA (Blog)

O pipeline já tem suporte a Soro IA, mas está **desabilitado por padrão** (`config/soro.json: enabled: false`).

Para ativar quando o blog estiver pronto:
1. Contratar Soro IA ($39/mês) em soroIA.com
2. Configurar webhook no `.env`:
   ```
   SORO_WEBHOOK_URL=https://seusite.com/api/soro-webhook
   SORO_WEBHOOK_SECRET=seu_secret_aqui
   ```
3. Em `config/soro.json`, mudar `"enabled": true`

O artigo é gerado por Claude (com keyword targeting) e enviado para o blog automaticamente após cada upload.

---

## Estratégia de Crescimento

**Motor 1 — YouTube**: K-dramas (conteúdo evergreen) rankeiam no YouTube Search meses depois. Fan meetings (conteúdo temporal) geram pico de views logo após o evento.

**Motor 2 — Google SEO**: Cada vídeo gera um artigo de blog com keyword targeting. Blog direciona para o canal. Com 8 artigos/mês, estimativa de tráfego orgânico em 3–6 meses.

**Alimentação**: Raquel posta no Instagram → legenda vira brief → Claude escreve roteiro → vídeo + artigo publicados automaticamente.
