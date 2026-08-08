# Design Spec — YouTube Rhetoric Analysis Pipeline

**Data:** 2026-08-08  
**Status:** Aprovado  
**Projeto:** Canal automatizado de análise de retórica / persuasão

---

## 1. Contexto e Objetivo

Criar um canal no YouTube que usa vídeos de figuras públicas brasileiras (caso inicial: Pablo Marçal) como material de estudo para análise de retórica, persuasão e comunicação. O canal opera com **automação total** — nenhuma ação manual após setup — postando 3 vídeos/dia com narração de persona IA e edição automática.

O ativo de valor real é o **pipeline**, não o personagem. A troca de creator-alvo exige mudança mínima de configuração.

---

## 2. Decisões de Design

| Dimensão | Decisão | Razão |
|---|---|---|
| Ângulo | Análise de retórica / educação | CPM maior, risco copyright menor, conteúdo perene |
| Avatar | Persona neutra IA (sem rosto real) | Anonymato, escalável, sem vínculo pessoal |
| Formato vídeo | Narração IA + clip original + texto na tela | Viável em R$140/mês, sem GPU dedicada |
| Upload freq. | 3 vídeos/dia | Maximiza crescimento algorítmico |
| Infraestrutura | Servidor Azure VM existente | Zero custo adicional |
| Creator inicial | Pablo Marçal (@pablomarcall) | 3,9M inscritos, ~55k views/dia, alta polarização = alto engajamento |

---

## 3. Arquitetura do Pipeline

```
[cron 30min]
     ↓
① MONITOR — YouTube Data API v3
   Verifica canal alvo → novo vídeo? → dispara pipeline
   Estado persistido em SQLite (tabela: processed_videos)
     ↓
② DOWNLOAD — yt-dlp
   Baixa vídeo MP4 + metadados → pasta temporária
     ↓
③ TRANSCRIÇÃO — Whisper (modelo medium, CPU)
   Output: JSON {segments: [{start, end, text}]}
     ↓
④ ANÁLISE — Claude API (claude-haiku-4-5 para custo)
   Prompt: transcrição completa → identifica técnicas retóricas,
   seleciona melhor trecho (60–120s), gera script de narração (~90s),
   sugere título SEO + tags
   Output: JSON {clip_start, clip_end, narration_script, title, description, tags}
     ↓
⑤ [paralelo]
   ④a NARRAÇÃO — ElevenLabs API (voz da persona)
        Script → MP3
   ④b CLIP — ffmpeg
        Recorta trecho do vídeo original pelos timestamps
     ↓
⑥ MONTAGEM — ffmpeg
   Estrutura final:
   [intro 5s] → [narração IA sobre clip mudo] → [clip original com áudio] → [texto análise] → [outro 5s]
   Legenda automática via Whisper (SRT gerado na etapa ③)
   Gera 2 arquivos: 16:9 (vídeo longo) + 9:16 vertical (Short)
     ↓
⑦ FILA — SQLite queue
   Insere na fila com scheduled_time: próximo slot livre
   Slots: 12:00, 18:00, 21:00 (BRT) — pico de audiência BR
     ↓
⑧ UPLOAD — YouTube Data API v3 (OAuth2)
   Publica vídeo + Short com metadados gerados por IA
   Registra video_id em SQLite
```

---

## 4. Stack Técnico

| Componente | Tecnologia | Custo |
|---|---|---|
| Linguagem | Python 3.12 | Grátis |
| Scheduler | Cron Linux + SQLite | Grátis |
| Download | yt-dlp | Grátis |
| Transcrição | Whisper (openai-whisper, local) | Grátis |
| Análise IA | Claude Haiku API | ~$1–2/mês |
| Narração | ElevenLabs Creator (100k chars/mês) | $22/mês |
| Edição | ffmpeg | Grátis |
| Upload | YouTube Data API v3 | Grátis |
| Servidor | Azure VM existente | R$0 adicional |
| Repositório | GitHub privado | Grátis |

**Total estimado: ~$24/mês (R$140)**

---

## 5. Estrutura de Dados — SQLite

```sql
-- Vídeos do creator monitorado
CREATE TABLE source_videos (
    id TEXT PRIMARY KEY,          -- YouTube video ID
    creator TEXT NOT NULL,        -- ex: 'pablomarcall'
    title TEXT,
    published_at TEXT,
    processed_at TEXT,
    status TEXT DEFAULT 'pending' -- pending | processing | done | error
);

-- Vídeos gerados para o canal
CREATE TABLE output_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_video_id TEXT,
    clip_start REAL,
    clip_end REAL,
    title TEXT,
    description TEXT,
    tags TEXT,                    -- JSON array
    scheduled_time TEXT,          -- ISO 8601
    uploaded_at TEXT,
    youtube_video_id TEXT,
    status TEXT DEFAULT 'queued'  -- queued | uploading | done | error
);
```

---

## 6. Estimativa de Receita

### Base: Canal Pablo Marçal (@pablomarcall)
- Inscritos: 3,9M
- Views/dia média atual: ~55k (pico: 133k, vale: 14k)
- Total histórico: 76M views em 16 anos

### Hipóteses para o canal de análise
- Canais de cortes/análise tipicamente atingem 3–15% das views do canal original
- RPM educação/retórica BR: $1,50–3,00 por 1.000 views
- YouTube Partner Program (monetização): ~500 subs + 3k horas (básico) | 1k subs + 4k horas (completo)
- Com 3 vídeos/dia: estimativa de ~90 dias para atingir limites do YPP

### Projeções mensais (após monetização ativa)

| Cenário | Views/dia | Mês 6 (R$) | Mês 12 (R$) | Observação |
|---|---|---|---|---|
| Pessimista (3% do Marçal) | 1.650 | R$150 | R$300 | Não paga ferramentas |
| **Moderado (8%)** | **4.400** | **R$1.540** | **R$3.080** | **Break-even mês 4–5** |
| Otimista (15%) | 8.250 | R$2.890 | R$5.780 | Marçal cita o canal |
| Viral (1 vídeo explode) | 50k+ | R$17.500 | — | Evento de baixa prob. |

*RPM base: $2,00/1k views · Câmbio R$5,80*

### Receita por 1.000.000 de views
| Tipo de conteúdo | RPM estimado | Receita |
|---|---|---|
| Político puro BR | $0,50–1,00 | **R$2.900–5.800** |
| Análise / educação BR | $1,50–3,00 | **R$8.700–17.400** |

### Custos vs receita (cenário moderado)
| Período | Receita | Custo | Saldo |
|---|---|---|---|
| Meses 1–3 | R$0 (sem YPP) | R$420 | -R$420 |
| Meses 4–6 | R$1.540/mês | R$140/mês | +R$1.400/mês |
| Mês 12 | R$3.080/mês | R$140/mês | +R$2.940/mês |

**Payback total do investimento inicial (~R$420): atingido no mês 4.**

---

## 7. Estrutura de Pastas do Projeto

```
youtube-rhetoric-pipeline/
├── pipeline/
│   ├── monitor.py        # YouTube API watcher
│   ├── downloader.py     # yt-dlp wrapper
│   ├── transcriber.py    # Whisper wrapper
│   ├── analyzer.py       # Claude API prompt + parsing
│   ├── narrator.py       # ElevenLabs API
│   ├── editor.py         # ffmpeg orchestration
│   ├── uploader.py       # YouTube Data API v3
│   └── queue.py          # SQLite queue manager
├── config/
│   ├── creators.json     # lista de creators monitorados
│   ├── persona.json      # nome, voz ID, prompt base da persona
│   └── schedule.json     # slots de upload por dia
├── assets/
│   ├── intro.mp4
│   ├── outro.mp4
│   └── logo.png
├── data/
│   └── pipeline.db       # SQLite
├── prompts/
│   └── rhetoric_analysis.txt   # prompt base para Claude
├── main.py               # entry point + cron dispatcher
├── requirements.txt
└── .env                  # API keys (não commitar)
```

---

## 8. Riscos e Mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Copyright strike no clip | Média | Comentário/análise = fair use. Clip < 60s. Se strike: encurtar clip para 30s |
| Marçal perde relevância | Média (12 meses) | `creators.json` — troca de alvo em minutos sem reescrever código |
| YouTube suspende canal | Baixa | Sempre adicionar valor editorial real. Não reusar clip sem narração |
| Whisper lento no servidor | Baixa | Modelo `small` como fallback. CPU suficiente para ~20min de áudio/vídeo |
| ElevenLabs quota excede | **Alta** | 100k chars/mês. Narração limitada a **55s máximo (~800 chars/vídeo)** → 90 × 800 = 72k chars, margem confortável. Se precisar de narração maior → upgrade para Scale $99/mês (500k chars) |

---

## 9. Fora de Escopo (v1)

- Dashboard de analytics
- Thumbnail gerada por IA (usar template ffmpeg estático por ora)
- Múltiplos creators simultâneos (arquitetura suporta, mas v1 foca em Marçal)
- Moderação automática de comentários
- Monetização por AdSense configurada automaticamente (setup manual uma vez)
