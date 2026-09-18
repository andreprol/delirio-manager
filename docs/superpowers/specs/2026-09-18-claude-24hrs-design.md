# Design — Claude 24hrs (óculos com IA sempre disponível)

**Status: pausado após brainstorming inicial.** André vai comprar o hardware
mais pra frente ("não será tão cedo") — este doc existe pra retomar do ponto
certo, sem re-perguntar tudo de novo.

## Contexto / objetivo

André quer acesso à IA (Claude + o RAG próprio) 24h, em qualquer lugar,
hands-free, via um óculos. Dois motivos guiaram as decisões de hardware:

1. **Discrição** — não pode ser reconhecível como dispositivo de IA/gravação
   (descarta óculos de marca conhecida tipo Meta Ray-Ban).
2. **Controle total** — hardware e pipeline próprios, sem depender de
   ecossistema fechado. Confirmado: Meta Ray-Ban não tem SDK público pra
   pipeline de visão customizado.

Caso de uso do MVP: **diagnóstico técnico geral** — identificar peça, ler
manual, resolver erro de código na tela. (Assistente de conversa/reunião fica
pra depois.)

## Arquitetura

```
[G1: display]  ←BLE→  [Infinix Android + SIM: ponte]  ←LTE/HTTPS→  [Cloud VPS]  ←heartbeat/sync→  [PC de casa]
[XIAO: câmera+mic+wake-word]  ←BLE→  (mesma ponte)                  proxy + índice        RAG completo + índice mestre
                                                                      fallback              + Claude/GPT vision API
```

Nenhum periférico (G1, XIAO) fala com a internet diretamente — só BLE com o
Infinix, que é o único ponto com dados móveis. Isso mantém bateria baixa nos
dois periféricos e evita antena grande em qualquer um deles (discrição).

## Componentes

### Display — Even Realities G1
- ~US$499 (sem grau; +US$159 com grau), loja oficial
  [evenrealities.com/g1](https://www.evenrealities.com/g1)
- 44g, resolução 640×200 (texto/gráfico mono verde), FOV 25°, bateria 160mAh
  (~1,5 dia), case de carga 2000mAh
- Sem câmera — só HUD. Protocolo BLE decifrado pela comunidade (sem API
  oficial pra terceiros): [G1_Extended](https://github.com/LabbeSimon/G1_Extended),
  Open G1 SDK, MentraOS — dá pra mandar texto pro display 100% via app/servidor
  próprio, sem depender do app oficial da Even.

### Câmera + mic — Seeed XIAO ESP32S3 Sense
- ~US$15, versão pré-soldada recomendada (evita soldar o conector da câmera):
  [seeedstudio.com/Seeed-Studio-XIAO-ESP32S3-Sense-Pre-Soldered-p-6335.html](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32S3-Sense-Pre-Soldered-p-6335.html)
- ESP32-S3, 240MHz dual-core, 8MB PSRAM + 8MB Flash, WiFi+BLE 5.0, câmera
  OV2640 (1600×1200, upgradable pra OV5640), microfone digital embutido,
  21×17.5mm
- Roda **openWakeWord** on-device (não o WakeNet da Espressif — esse exige
  corpus de 500+ pessoas pra frase customizada, inviável pra projeto pessoal).
  openWakeWord treina com a própria voz do André + dados sintéticos, mantém
  a detecção 100% local (nenhum áudio sai do dispositivo até a frase
  disparar) — resolve a preocupação de privacidade de "escuta contínua".

### Montagem física (não modificar o G1 internamente)
- Sensor de câmera: canto do aro, perto da dobradiça, voltado pra frente
- Placa XIAO: colada dentro da haste
- Bateria LiPo do XIAO: mais atrás na haste, antes da ponta
- Ponta da haste = eletrônica original do G1 (bateria+driver do display) —
  não mexer
- Fixação: clip 3D impresso na Bambu Lab A1 do André, desenhado em OpenSCAD
  (CAD por código → STL → fatia no Bambu Studio)
- **Em aberto:** 1 peça (snap-fit, mais simples mas desgasta com uso) vs 2
  peças + parafusos M2 (mais firme, mais trabalho). Medidas reais da haste
  do G1 (largura/espessura) não estão na especificação oficial nem em fontes
  de terceiros — resolver com paquímetro quando o óculos chegar, ou checar o
  modelo "Even Realities G1A/G1B Sizer" no MakerWorld antes disso
  ([makerworld.com/en/models/828245](https://makerworld.com/en/models/828245-even-realities-g1a-g1b-sizer-models)).

### Ponte de rede — celular Infinix (Android) dedicado
- Android escolhido em vez de iPhone: conta de desenvolvedor Apple do André
  está bloqueada e não há Mac/Xcode pra compilar um app nativo assinado — rota
  iOS descartada.
- Chip/SIM próprio no Infinix (mais barato que resolver conectividade celular
  direto nos óculos).
- App nativo Android: recebe foto+áudio via BLE do XIAO, texto de estado do
  G1; fala com o backend via LTE; envia respostas de volta pro G1 via BLE.

## Fluxo de interação

1. André fala a frase-gatilho (a definir) → openWakeWord dispara no XIAO
2. XIAO captura foto + grava a pergunta falada
3. Infinix recebe os dois via BLE, envia pro backend via LTE
4. Backend: STT (Whisper) na pergunta + visão na foto + RAG → resposta
5. Resposta (texto curto — tela é 640×200 mono, sem espaço pra parágrafo)
   volta pro Infinix → BLE → G1 mostra no HUD
6. Meta de latência ponta-a-ponta: **2-5 segundos**

**Fallback manual:** botão físico dispara o mesmo fluxo (ambiente ruidoso,
frase não reconhecida, ou preferência por clique).

**Desligar** (sempre físico, nunca por voz — precisa ser determinístico):
segurar o botão por alguns segundos = mic+câmera dormem, wake-word para.

**Pausar** (voz, conveniência): frase tipo "Claude, pausar" reconhecida pelo
mesmo motor de wake-word = ignora comandos por N minutos ou até reativação
manual. Sujeita à mesma limitação de qualquer detecção de voz (não garantida).

**Confirmação de estado:** sem LED (quebraria a discrição) — o próprio G1
mostra texto rápido ("Ativo"/"Pausado") a cada mudança de estado, visível só
pro André.

## Backend / RAG

Construído do zero em Python — decisão explícita do André: controle total,
zero dependência de terceiros (avaliado e descartado: adotar AnythingLLM,
Danswer/Onyx ou Khoj prontos).

**Fontes do RAG:**
- Memória do Claude Code
- GitHub
- Obsidian
- NotebookLM — só via **export periódico**, não consulta ao vivo (NotebookLM
  não tem API estável, só funciona via browser — ver
  [[feedback_notebooklm_cli_sempre_falha]])
- Busca na internet ao vivo, como complemento

**Sincronização:** índice vetorial único, sync automático a cada 6h (não é
consulta ao vivo por pergunta — mantém a latência de 2-5s viável).

## Hospedagem híbrida + failover

- **Cloud VPS/Azure** — porta de entrada fixa, sempre acessível pelo Infinix
  via LTE, faz proxy pro PC de casa
- **PC de casa** — processamento pesado, índice RAG completo; cloud manda
  heartbeat periódico
- **PC de casa cai** → cloud responde com cópia própria do índice
  (sincronizada a cada 6h) — resposta degradada, mas funciona
- **Cloud cai** → sistema para (ponto único — o Infinix só fala com a
  cloud). Precisa de monitor **externo** terceiro, já que a cloud não pode se
  autodetectar caída
- **Alertas:** Telegram/WhatsApp + e-mail, reaproveitando o skill/monitor
  `watch` já instalado em vez de montar monitoramento do zero

## Linha de investigação aberta — integração com JARVIS

André já tem o **JARVIS** rodando (`F:\Arquivos Acadêmicos\Jarvis`,
localhost:3000, Managed Agent da Anthropic com memória persistente e
integrações Gmail/GCalendar/GitHub/MS Graph — ver [[project_jarvis]]).

Se ainda estiver ativo, isso muda a decisão de backend: o Managed Agent já
roda hospedado na nuvem da Anthropic (resolveria a "porta de entrada sempre
disponível" sem precisar de VPS separada) e já tem sync automático de
memória/vault. Os óculos poderiam plugar no JARVIS existente em vez de um
RAG construído do zero.

**⚠️ A memória do JARVIS tem 70+ dias — confirmar que ainda está no ar e no
mesmo formato antes de decidir a integração, não assumir.**

## Pendências pra retomar

- [ ] Confirmar estado atual do JARVIS (ainda rodando? Managed Agent ainda
      ativo?) antes de decidir se os óculos plugam nele ou num RAG próprio
- [ ] Comprar G1 (~US$499) + XIAO ESP32S3 Sense pré-soldado (~US$15) + chip/SIM
      pro Infinix
- [ ] Medir a haste do G1 (paquímetro ou modelo MakerWorld) e decidir clip 1
      peça vs 2 peças+M2
- [ ] Definir a frase-gatilho exata do wake-word e treinar o modelo
      openWakeWord com a voz do André
- [ ] Escolher provedor de cloud VPS/Azure pro proxy de failover
