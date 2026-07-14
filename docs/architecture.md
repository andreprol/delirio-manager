# Arquitetura — Delirio Manager

O Delirio Manager é um sistema de monitoramento de parque de TI composto por um agente Go instalado em cada PC Windows, um servidor Node.js hospedado em VM Azure e um dashboard Electron/React para visualização e gestão. Toda a comunicação entre o dashboard e o servidor ocorre via Cloudflare Tunnel, sem portas abertas na VM. Um banco SQLite centralizado persiste todos os dados de máquinas, métricas, tickets e configurações.

## Diagrama Geral

```mermaid
graph TD
    subgraph PCs["120+ PCs Windows"]
        AGT["Go Agent\n(serviço NSSM)"]
    end

    subgraph AzureVM["Azure VM (Ubuntu)"]
        SRV["Node.js Server\n(Express :3001)"]
        DB[("SQLite\n/opt/dt-manager/data/\ndt-manager.db")]
        SRV <-->|"db.js"| DB
    end

    subgraph Externo["Serviços Externos"]
        ZAMAK["Zamak API\n(segurança / patches)"]
        FRESH["Freshdesk API\n(tickets IT)"]
        CLAUDE["Claude API\n(narrativas IA)"]
        GHA["GitHub Actions CI\n(Go tests + ESLint + Jest)"]
        CF["Cloudflare Tunnel"]
    end

    DASH["Electron + React\nDashboard\n(Windows desktop)"]

    AGT -->|"POST heartbeat + métricas (HTTP)"| SRV
    DASH -->|"HTTP REST"| CF
    CF -->|"proxy seguro"| SRV
    SRV -->|"consulta patches / ameaças"| ZAMAK
    SRV -->|"consulta tickets (cache 4h)"| FRESH
    SRV -->|"gera narrativas do relatório"| CLAUDE
    GHA -->|"push → testes + lint + coverage"| SRV
```

## Camadas do Servidor

```mermaid
graph LR
    subgraph Routes["Camada de Rotas"]
        R1["agent.js"]
        R2["machines.js"]
        R3["rh.js"]
        R4["settings.js"]
        R5["aloha.js"]
        R6["...outros"]
    end

    subgraph Services["Camada de Serviços"]
        S1["alertEngine"]
        S2["reportEngine"]
        S3["insightEngine"]
        S4["zamak"]
        S5["ncrMonitor"]
        S6["nfce-mailer"]
    end

    subgraph Data["Camada de Dados"]
        DB["db.js\n(SQLite)"]
    end

    Routes --> Services
    Services --> Data
```
