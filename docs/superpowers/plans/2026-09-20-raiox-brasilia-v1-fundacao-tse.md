# RaioX Brasília — Plano 1: Fundação + Candidatura TSE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colocar no ar uma versão funcional mínima do RaioX Brasília: busca por nome/número/partido retornando uma ficha por político, populada com dado real de candidatura do TSE (ciclo 2026), cada informação com fonte e data de coleta visíveis.

**Architecture:** Next.js (App Router, páginas renderizadas no servidor) + Postgres via Supabase. Um robô Node/TypeScript baixa o arquivo aberto de candidatura do TSE, resolve identidade da pessoa (por CPF, com fallback nome+nascimento) e grava no banco de forma idempotente. Site lê só do banco, nunca da fonte diretamente.

**Tech Stack:** Next.js 15 (TypeScript, App Router), Supabase (Postgres), Vitest, `csv-parse`, `adm-zip`, `iconv-lite`.

**Escopo deste plano** (referência: spec em `docs/superpowers/specs/2026-09-20-raiox-brasilia-design.md`): apenas o pilar "candidatura" (TSE). Financiamento de campanha, votação, processo judicial e apoio formal são planos seguintes — cada um adiciona uma seção na mesma ficha, sem retrabalho de arquitetura.

**Nota sobre um fato descoberto durante a pesquisa desta spec**: em 2024 o TSE chegou a ocultar o CPF de candidato em dado aberto (Resolução TSE nº 23.729/2024, justificativa LGPD), mas recuou após pressão de sociedade civil (Abraji, Transparência Brasil) e vai voltar a divulgar CPF nas eleições de 2026. Ainda assim, o robô trata CPF como **opcional** (usa como identificador principal quando presente, cai para nome+data de nascimento quando ausente) — assim o sistema não quebra se isso mudar de novo no futuro.

---

### Task 1: Fundação do projeto

**Files:**
- Create: `raiox-brasilia/` (novo repositório, fora do repo atual do RichClub)
- Create: `raiox-brasilia/.env.example`
- Create: `raiox-brasilia/vitest.config.ts`
- Create: `raiox-brasilia/vitest.setup.ts`

- [ ] **Step 1: Criar o projeto Next.js**

```bash
cd F:/RichClub
npx create-next-app@latest raiox-brasilia --typescript --eslint --app --import-alias "@/*"
```

Se o CLI perguntar sobre Tailwind ou Turbopack de forma interativa, responda "No" pros dois — não precisamos deles neste plano.

- [ ] **Step 2: Instalar dependências de fundação**

```bash
cd raiox-brasilia
npm install @supabase/supabase-js
npm install -D vitest dotenv tsx
```

- [ ] **Step 3: Configurar Vitest**

Crie `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

Crie `vitest.setup.ts`:

```ts
import { config } from "dotenv";

config({ path: ".env.local" });
```

Adicione em `package.json`, dentro de `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 4: Criar `.env.example`**

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_EMAIL_CONTATO=
```

`NEXT_PUBLIC_EMAIL_CONTATO` é o e-mail que aparece na ficha como canal de correção (spec exige isso desde o v1 — alguém pode reclamar "esse processo é de homônimo"). Preencha com o e-mail que você quer usar pra esse projeto antes do Task 8.

Confirme que `.env*.local` já está no `.gitignore` gerado pelo `create-next-app` (deve estar, por padrão).

- [ ] **Step 5: Rodar o projeto pra confirmar que o scaffold funciona**

```bash
npm run dev
```

Esperado: servidor sobe em `http://localhost:3000` sem erro. Pare com Ctrl+C.

- [ ] **Step 6: Commit inicial**

```bash
git init
git add -A
git commit -m "chore: scaffold inicial do RaioX Brasília (Next.js + Supabase)"
```

---

### Task 2: Banco de dados — schema `pessoa` e `candidatura`

**Files:**
- Create: `raiox-brasilia/supabase/migrations/0001_pessoa_candidatura.sql`

- [ ] **Step 1: Criar projeto Supabase**

Manual, no painel (`https://supabase.com/dashboard`): criar novo projeto chamado `raiox-brasilia`. Anote a **Project URL** e a **service_role key** (Settings → API) — vão pro `.env.local` (não commitado):

```
SUPABASE_URL=https://<seu-projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<sua-chave-service-role>
```

- [ ] **Step 2: Escrever a migração**

Crie `supabase/migrations/0001_pessoa_candidatura.sql`:

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table pessoa (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  nome_civil text not null,
  data_nascimento date,
  sg_uf_nascimento text,
  nm_municipio_nascimento text,
  cpf text unique,
  oculto boolean not null default false,
  motivo_ocultacao_judicial text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index pessoa_nome_trgm_idx on pessoa using gin (nome_civil gin_trgm_ops);

create table candidatura (
  id uuid primary key default gen_random_uuid(),
  pessoa_id uuid not null references pessoa(id) on delete restrict,
  ano_eleicao integer not null,
  turno integer not null,
  cargo text not null,
  sg_uf text not null,
  nr_candidato text not null,
  nm_urna text not null,
  sg_partido text not null,
  nm_partido text,
  situacao text,
  sq_candidato_tse text not null,
  oculto boolean not null default false,
  motivo_ocultacao_judicial text,
  fonte_url text not null,
  coletado_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  unique (ano_eleicao, turno, sq_candidato_tse)
);

create index candidatura_pessoa_idx on candidatura (pessoa_id);
create index candidatura_busca_idx on candidatura using gin (nm_urna gin_trgm_ops);

alter table pessoa enable row level security;
alter table candidatura enable row level security;

create or replace function set_atualizado_em()
returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

create trigger pessoa_atualizado_em
  before update on pessoa
  for each row
  execute function set_atualizado_em();
```

**Nota (revisão de código pegou isso, corrigido em relação ao rascunho original deste plano)**: `pessoa_id` usa `on delete restrict`, não `cascade` — o projeto nunca apaga registro de verdade (só marca oculto), então apagar uma `pessoa` sem antes tratar as `candidatura` dela é bloqueado de propósito. RLS habilitado sem nenhuma policy — correto, porque a aplicação só acessa via `service_role` key (que bypassa RLS), nunca via `anon`/`authenticated`.

- [ ] **Step 3: Aplicar a migração**

Via conexão direta ao Postgres (`SUPABASE_DB_URL`, connection string do **Session pooler** — a conexão direta do Supabase é IPv6-only e pode não funcionar dependendo da rede), usando `scripts/db/aplicar_migracao.ts` (criado nesta mesma task). Não precisa colar no SQL Editor do painel.

Esperado: duas tabelas (`pessoa`, `candidatura`) aparecem, com RLS ativo, sem erro.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_pessoa_candidatura.sql scripts/db
git commit -m "feat(db): schema inicial de pessoa e candidatura, com RLS"
```

---

### Task 3: Inspecionar o layout real do arquivo do TSE

Antes de escrever o parser, confirmamos o formato real do arquivo — documentação de terceiros sobre o layout do TSE é inconsistente entre fontes, então validamos direto na fonte.

**Files:**
- Create: `raiox-brasilia/scripts/ingest/tse/inspecionar_layout.ts`

- [ ] **Step 1: Instalar dependências de leitura do zip**

```bash
npm install adm-zip iconv-lite
npm install -D @types/adm-zip
```

- [ ] **Step 2: Escrever o script de inspeção**

```ts
// scripts/ingest/tse/inspecionar_layout.ts
import AdmZip from "adm-zip";
import iconv from "iconv-lite";

const URL_ZIP =
  "https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_2026.zip";

async function main() {
  const resposta = await fetch(URL_ZIP);
  if (!resposta.ok) {
    throw new Error(`Falha ao baixar ${URL_ZIP}: HTTP ${resposta.status}`);
  }
  const buffer = Buffer.from(await resposta.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entradas = zip.getEntries();

  console.log("Arquivos dentro do zip:");
  for (const entrada of entradas) {
    console.log(`- ${entrada.entryName} (${entrada.header.size} bytes)`);
  }

  const arquivoBrasil = entradas.find((e) => /_BRASIL\.csv$/i.test(e.entryName));
  if (!arquivoBrasil) {
    throw new Error(
      "Não achei um arquivo consolidado *_BRASIL.csv no zip — confira a lista acima e ajuste o filtro deste script."
    );
  }

  const conteudoUtf8 = iconv.decode(arquivoBrasil.getData(), "latin1");
  const linhas = conteudoUtf8.split(/\r?\n/);

  console.log("\nCabeçalho (nomes de coluna, nessa ordem):");
  console.log(linhas[0]);
  console.log("\nPrimeira linha de dado:");
  console.log(linhas[1]);
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
```

- [ ] **Step 3: Rodar e conferir**

```bash
npx tsx scripts/ingest/tse/inspecionar_layout.ts
```

Esperado: lista de arquivos do zip, seguida do cabeçalho real do arquivo `*_BRASIL.csv`.

**Verificação obrigatória antes de continuar pro Task 4**: confira se as colunas abaixo aparecem no cabeçalho impresso, com esses nomes exatos: `ANO_ELEICAO`, `NR_TURNO`, `DS_CARGO`, `SG_UF`, `NR_CANDIDATO`, `NM_URNA_CANDIDATO`, `NM_CANDIDATO`, `SG_PARTIDO`, `NM_PARTIDO`, `DS_SIT_TOT_TURNO`, `SQ_CANDIDATO`, `NR_CPF_CANDIDATO`, `DT_NASCIMENTO`, `SG_UF_NASCIMENTO`, `NM_MUNICIPIO_NASCIMENTO`. Se algum nome vier diferente (o TSE já renomeou campo entre eleições antes), **ajuste os nomes usados no Task 4 antes de escrever o parser** — não prossiga com nome assumido sem checar.

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest/tse/inspecionar_layout.ts package.json package-lock.json
git commit -m "chore(ingest): script de inspeção do layout de candidatura do TSE"
```

---

### Task 4: Parser do CSV de candidatura

**Achado da Task 3 (inspeção real do TSE)**: o cabeçalho real do arquivo `consulta_cand_2026_BRASIL.csv` **não tem** a coluna `NM_MUNICIPIO_NASCIMENTO` (documentação de terceiros estava errada nesse ponto). Colunas confirmadas de verdade no arquivo real (52 colunas ao todo, listando só as usadas por este parser): `ANO_ELEICAO`, `NR_TURNO`, `DS_CARGO`, `SG_UF`, `NR_CANDIDATO`, `NM_URNA_CANDIDATO`, `NM_CANDIDATO`, `SG_PARTIDO`, `NM_PARTIDO`, `DS_SIT_TOT_TURNO`, `SQ_CANDIDATO`, `NR_CPF_CANDIDATO`, `DT_NASCIMENTO`, `SG_UF_NASCIMENTO` — todas confirmadas presentes com esses nomes exatos. O parser abaixo já foi ajustado pra não depender de `NM_MUNICIPIO_NASCIMENTO`. A coluna `nm_municipio_nascimento` já existe no banco (Task 2) — fica sempre `null` por enquanto (nullable, sem custo, não vale reabrir migração por isso).

**Files:**
- Create: `raiox-brasilia/scripts/ingest/tse/parse_candidatura.ts`
- Test: `raiox-brasilia/scripts/ingest/tse/parse_candidatura.test.ts`

- [ ] **Step 1: Instalar dependência de parsing**

```bash
npm install csv-parse
```

- [ ] **Step 2: Escrever o teste (vai falhar — módulo ainda não existe)**

```ts
// scripts/ingest/tse/parse_candidatura.test.ts
import { describe, it, expect } from "vitest";
import { parseCandidaturaCsv } from "./parse_candidatura";

const CABECALHO =
  "ANO_ELEICAO;NR_TURNO;DS_CARGO;SG_UF;NR_CANDIDATO;NM_URNA_CANDIDATO;NM_CANDIDATO;SG_PARTIDO;NM_PARTIDO;DS_SIT_TOT_TURNO;SQ_CANDIDATO;NR_CPF_CANDIDATO;DT_NASCIMENTO;SG_UF_NASCIMENTO";

const LINHA_EXEMPLO =
  "2026;1;GOVERNADOR;RR;10;MARIA TESTE;MARIA DA SILVA TESTE;PARTIDO X;PARTIDO EXEMPLO;#NULO#;123456789012345;12345678900;15/03/1975;RR";

describe("parseCandidaturaCsv", () => {
  it("converte uma linha de candidatura corretamente", () => {
    const [registro] = parseCandidaturaCsv(`${CABECALHO}\n${LINHA_EXEMPLO}`);

    expect(registro.anoEleicao).toBe(2026);
    expect(registro.turno).toBe(1);
    expect(registro.cargo).toBe("GOVERNADOR");
    expect(registro.sgUf).toBe("RR");
    expect(registro.nmUrna).toBe("MARIA TESTE");
    expect(registro.cpf).toBe("12345678900");
    expect(registro.dataNascimento).toBe("1975-03-15");
    expect(registro.situacao).toBe("NAO_DIVULGADO");
  });

  it("trata CPF marcado como #NULO# como null", () => {
    const linhaSemCpf = LINHA_EXEMPLO.replace("12345678900", "#NULO#");
    const [registro] = parseCandidaturaCsv(`${CABECALHO}\n${linhaSemCpf}`);
    expect(registro.cpf).toBeNull();
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npx vitest run scripts/ingest/tse/parse_candidatura.test.ts
```

Esperado: FAIL, `Cannot find module './parse_candidatura'`.

- [ ] **Step 4: Implementar o parser**

```ts
// scripts/ingest/tse/parse_candidatura.ts
import { parse } from "csv-parse/sync";

export interface CandidaturaTSE {
  anoEleicao: number;
  turno: number;
  cargo: string;
  sgUf: string;
  nrCandidato: string;
  nmUrna: string;
  nmCandidato: string;
  sgPartido: string;
  nmPartido: string;
  situacao: string;
  sqCandidatoTse: string;
  cpf: string | null;
  dataNascimento: string | null;
  sgUfNascimento: string | null;
}

const VALORES_NULOS = new Set(["#NULO#", "#NULO", "", "-1", "-3"]);

function limpar(valor: string | undefined): string | null {
  if (valor === undefined) return null;
  const v = valor.trim();
  return VALORES_NULOS.has(v) ? null : v;
}

function converterDataBrParaIso(dataBr: string): string {
  const [dia, mes, ano] = dataBr.split("/");
  return `${ano}-${mes}-${dia}`;
}

export function parseCandidaturaCsv(conteudoUtf8: string): CandidaturaTSE[] {
  const registros: Record<string, string>[] = parse(conteudoUtf8, {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
  });

  return registros.map((linha) => {
    const dataNascBr = limpar(linha["DT_NASCIMENTO"]);
    return {
      anoEleicao: Number(linha["ANO_ELEICAO"]),
      turno: Number(linha["NR_TURNO"]),
      cargo: linha["DS_CARGO"],
      sgUf: linha["SG_UF"],
      nrCandidato: linha["NR_CANDIDATO"],
      nmUrna: linha["NM_URNA_CANDIDATO"],
      nmCandidato: linha["NM_CANDIDATO"],
      sgPartido: linha["SG_PARTIDO"],
      nmPartido: linha["NM_PARTIDO"],
      situacao: limpar(linha["DS_SIT_TOT_TURNO"]) ?? "NAO_DIVULGADO",
      sqCandidatoTse: linha["SQ_CANDIDATO"],
      cpf: limpar(linha["NR_CPF_CANDIDATO"]),
      dataNascimento: dataNascBr ? converterDataBrParaIso(dataNascBr) : null,
      sgUfNascimento: limpar(linha["SG_UF_NASCIMENTO"]),
    };
  });
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

```bash
npx vitest run scripts/ingest/tse/parse_candidatura.test.ts
```

Esperado: PASS, 2 testes.

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest/tse/parse_candidatura.ts scripts/ingest/tse/parse_candidatura.test.ts package.json package-lock.json
git commit -m "feat(ingest): parser do CSV de candidatura do TSE"
```

---

### Task 5: Resolução de identidade da pessoa

Decide se uma candidatura pertence a uma `pessoa` já existente (por CPF, ou por nome+nascimento quando CPF não vier) ou se cria uma pessoa nova. Testado contra o Supabase real de desenvolvimento (não com mock) porque a lógica depende do comportamento real de `select`/`insert` do Postgres.

**Files:**
- Create: `raiox-brasilia/lib/supabase/server.ts`
- Create: `raiox-brasilia/scripts/ingest/tse/resolver_identidade.ts`
- Test: `raiox-brasilia/scripts/ingest/tse/resolver_identidade.test.ts`

- [ ] **Step 1: Cliente Supabase do servidor**

```ts
// lib/supabase/server.ts
import { createClient } from "@supabase/supabase-js";

export const supabaseServidor = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
```

- [ ] **Step 2: Escrever o teste (vai falhar — módulo ainda não existe)**

```ts
// scripts/ingest/tse/resolver_identidade.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { supabaseServidor } from "../../../lib/supabase/server";
import { resolverPessoaId } from "./resolver_identidade";
import type { CandidaturaTSE } from "./parse_candidatura";

const CPF_TESTE = "00000000191";

function candidaturaExemplo(sobrescreve: Partial<CandidaturaTSE> = {}): CandidaturaTSE {
  return {
    anoEleicao: 2026,
    turno: 1,
    cargo: "GOVERNADOR",
    sgUf: "RR",
    nrCandidato: "10",
    nmUrna: "MARIA TESTE",
    nmCandidato: "MARIA DA SILVA TESTE",
    sgPartido: "PX",
    nmPartido: "PARTIDO EXEMPLO",
    situacao: "ELEITO",
    sqCandidatoTse: "999999999999997",
    cpf: null,
    dataNascimento: "1975-03-15",
    sgUfNascimento: "RR",
    ...sobrescreve,
  };
}

afterEach(async () => {
  await supabaseServidor.from("pessoa").delete().eq("cpf", CPF_TESTE);
  await supabaseServidor
    .from("pessoa")
    .delete()
    .eq("nome_civil", "MARIA DA SILVA TESTE")
    .is("cpf", null);
});

describe("resolverPessoaId", () => {
  it("cria pessoa nova na primeira chamada e reaproveita na segunda, pelo CPF", async () => {
    const candidatura = candidaturaExemplo({ cpf: CPF_TESTE });

    const primeiroId = await resolverPessoaId(supabaseServidor, candidatura);
    const segundoId = await resolverPessoaId(supabaseServidor, candidatura);

    expect(segundoId).toBe(primeiroId);
  });

  it("sem CPF, reaproveita pessoa por nome + data de nascimento", async () => {
    const candidatura = candidaturaExemplo({ cpf: null });

    const primeiroId = await resolverPessoaId(supabaseServidor, candidatura);
    const segundoId = await resolverPessoaId(
      supabaseServidor,
      candidaturaExemplo({ cpf: null, sqCandidatoTse: "999999999999996" })
    );

    expect(segundoId).toBe(primeiroId);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npx vitest run scripts/ingest/tse/resolver_identidade.test.ts
```

Esperado: FAIL, `Cannot find module './resolver_identidade'`.

- [ ] **Step 4: Implementar**

```ts
// scripts/ingest/tse/resolver_identidade.ts
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandidaturaTSE } from "./parse_candidatura";

function gerarSlug(nomeCandidato: string): string {
  const base = nomeCandidato
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const sufixo = randomBytes(3).toString("hex");
  return `${base}-${sufixo}`;
}

export async function resolverPessoaId(
  supabase: SupabaseClient,
  candidatura: CandidaturaTSE
): Promise<string> {
  if (candidatura.cpf) {
    const { data, error } = await supabase
      .from("pessoa")
      .select("id")
      .eq("cpf", candidatura.cpf)
      .maybeSingle();
    if (error) throw error;
    if (data) return data.id;
  }

  if (candidatura.dataNascimento) {
    const { data, error } = await supabase
      .from("pessoa")
      .select("id")
      .eq("nome_civil", candidatura.nmCandidato)
      .eq("data_nascimento", candidatura.dataNascimento)
      .maybeSingle();
    if (error) throw error;
    if (data) return data.id;
  }

  const { data, error } = await supabase
    .from("pessoa")
    .insert({
      slug: gerarSlug(candidatura.nmCandidato),
      nome_civil: candidatura.nmCandidato,
      data_nascimento: candidatura.dataNascimento,
      sg_uf_nascimento: candidatura.sgUfNascimento,
      cpf: candidatura.cpf,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Pré-requisito: `.env.local` já preenchido (Task 2, Step 1).

```bash
npx vitest run scripts/ingest/tse/resolver_identidade.test.ts
```

Esperado: PASS, 2 testes. Confira no painel Supabase (Table Editor → `pessoa`) que não sobraram linhas de teste depois — o `afterEach` deve ter limpado.

- [ ] **Step 6: Commit**

```bash
git add lib/supabase/server.ts scripts/ingest/tse/resolver_identidade.ts scripts/ingest/tse/resolver_identidade.test.ts
git commit -m "feat(ingest): resolução de identidade da pessoa por CPF ou nome+nascimento"
```

---

### Task 6: Robô de ingestão (orquestrador + tratamento de erro de fonte)

**Files:**
- Create: `raiox-brasilia/scripts/ingest/tse/ingest_candidatura.ts`
- Test: `raiox-brasilia/scripts/ingest/tse/ingest_candidatura.test.ts`

- [ ] **Step 1: Escrever o teste de tratamento de erro (vai falhar — módulo ainda não existe)**

```ts
// scripts/ingest/tse/ingest_candidatura.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingerirCandidaturas2026 } from "./ingest_candidatura";

describe("ingerirCandidaturas2026 — fonte indisponível", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("não grava nada e não derruba o processo quando o download do TSE falha", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 503 } as Response);
    const supabaseFalso = { from: vi.fn() } as any;

    const resultado = await ingerirCandidaturas2026(supabaseFalso);

    expect(resultado.falhou).toBe(true);
    expect(resultado.processados).toBe(0);
    expect(supabaseFalso.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run scripts/ingest/tse/ingest_candidatura.test.ts
```

Esperado: FAIL, `Cannot find module './ingest_candidatura'`.

- [ ] **Step 3: Implementar o orquestrador**

```ts
// scripts/ingest/tse/ingest_candidatura.ts
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCandidaturaCsv } from "./parse_candidatura";
import { resolverPessoaId } from "./resolver_identidade";
import { supabaseServidor } from "../../../lib/supabase/server";

const URL_ZIP =
  "https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_2026.zip";

export interface ResultadoIngestao {
  processados: number;
  falhou: boolean;
}

export async function ingerirCandidaturas2026(
  supabase: SupabaseClient = supabaseServidor
): Promise<ResultadoIngestao> {
  let buffer: Buffer;
  try {
    const resposta = await fetch(URL_ZIP);
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    buffer = Buffer.from(await resposta.arrayBuffer());
  } catch (erro) {
    console.error(
      `[ingest_candidatura] Falha ao baixar ${URL_ZIP}: ${erro}. Dado já gravado foi mantido, nada foi alterado.`
    );
    return { processados: 0, falhou: true };
  }

  const zip = new AdmZip(buffer);
  const arquivoBrasil = zip.getEntries().find((e) => /_BRASIL\.csv$/i.test(e.entryName));
  if (!arquivoBrasil) {
    console.error(
      "[ingest_candidatura] Arquivo *_BRASIL.csv não encontrado no zip baixado. Dado já gravado foi mantido, nada foi alterado."
    );
    return { processados: 0, falhou: true };
  }

  const conteudoUtf8 = iconv.decode(arquivoBrasil.getData(), "latin1");
  const candidaturas = parseCandidaturaCsv(conteudoUtf8);

  let processados = 0;
  for (const candidatura of candidaturas) {
    const pessoaId = await resolverPessoaId(supabase, candidatura);
    const { error } = await supabase.from("candidatura").upsert(
      {
        pessoa_id: pessoaId,
        ano_eleicao: candidatura.anoEleicao,
        turno: candidatura.turno,
        cargo: candidatura.cargo,
        sg_uf: candidatura.sgUf,
        nr_candidato: candidatura.nrCandidato,
        nm_urna: candidatura.nmUrna,
        sg_partido: candidatura.sgPartido,
        nm_partido: candidatura.nmPartido,
        situacao: candidatura.situacao,
        sq_candidato_tse: candidatura.sqCandidatoTse,
        fonte_url: URL_ZIP,
        coletado_em: new Date().toISOString(),
      },
      { onConflict: "ano_eleicao,turno,sq_candidato_tse" }
    );
    if (error) {
      console.error(
        `[ingest_candidatura] Falha ao gravar candidatura ${candidatura.sqCandidatoTse}: ${error.message}`
      );
      continue;
    }
    processados += 1;
  }

  return { processados, falhou: false };
}

if (require.main === module) {
  ingerirCandidaturas2026().then((resultado) => {
    console.log(
      `[ingest_candidatura] Concluído: ${resultado.processados} candidatura(s) processada(s).`
    );
    process.exit(resultado.falhou ? 1 : 0);
  });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npx vitest run scripts/ingest/tse/ingest_candidatura.test.ts
```

Esperado: PASS, 1 teste.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest/tse/ingest_candidatura.ts scripts/ingest/tse/ingest_candidatura.test.ts
git commit -m "feat(ingest): robô orquestrador com tratamento de fonte indisponível"
```

---

### Task 7: Busca

**Files:**
- Create: `raiox-brasilia/lib/busca.ts`
- Test: `raiox-brasilia/lib/busca.test.ts`
- Modify: `raiox-brasilia/app/page.tsx`

- [ ] **Step 1: Escrever o teste (vai falhar — módulo ainda não existe)**

```ts
// lib/busca.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { supabaseServidor } from "./supabase/server";
import { buscarPoliticos } from "./busca";

const SLUG_TESTE = "candidato-teste-busca-9f8e7d";

beforeAll(async () => {
  const { data: pessoa, error } = await supabaseServidor
    .from("pessoa")
    .insert({ slug: SLUG_TESTE, nome_civil: "Candidato Teste Busca" })
    .select("id")
    .single();
  if (error) throw error;

  const { error: erroCandidatura } = await supabaseServidor.from("candidatura").insert({
    pessoa_id: pessoa.id,
    ano_eleicao: 2026,
    turno: 1,
    cargo: "DEPUTADO ESTADUAL",
    sg_uf: "RR",
    nr_candidato: "99999",
    nm_urna: "CANDIDATO TESTE BUSCA",
    sg_partido: "PTB",
    situacao: "AGUARDANDO JULGAMENTO",
    sq_candidato_tse: "999999999999995",
    fonte_url: "https://teste.local",
  });
  if (erroCandidatura) throw erroCandidatura;
});

afterAll(async () => {
  await supabaseServidor.from("candidatura").delete().eq("sq_candidato_tse", "999999999999995");
  await supabaseServidor.from("pessoa").delete().eq("slug", SLUG_TESTE);
});

describe("buscarPoliticos", () => {
  it("encontra por nome parcial, sem repetir a mesma pessoa", async () => {
    const resultados = await buscarPoliticos("Teste Busca");
    const encontrados = resultados.filter((r) => r.slug === SLUG_TESTE);
    expect(encontrados).toHaveLength(1);
  });

  it("retorna vazio para termo muito curto", async () => {
    const resultados = await buscarPoliticos("a");
    expect(resultados).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run lib/busca.test.ts
```

Esperado: FAIL, `Cannot find module './busca'`.

- [ ] **Step 3: Implementar**

```ts
// lib/busca.ts
import { supabaseServidor } from "./supabase/server";

export interface ResultadoBusca {
  pessoaId: string;
  slug: string;
  nome: string;
  cargoMaisRecente: string;
  partido: string;
  uf: string;
}

interface LinhaBusca {
  pessoa_id: string;
  nm_urna: string;
  cargo: string;
  sg_partido: string;
  sg_uf: string;
  pessoa: { slug: string; nome_civil: string } | null;
}

export async function buscarPoliticos(termo: string): Promise<ResultadoBusca[]> {
  const termoLimpo = termo.trim();
  if (termoLimpo.length < 2) return [];

  const { data, error } = await supabaseServidor
    .from("candidatura")
    .select(
      "pessoa_id, nm_urna, cargo, sg_partido, sg_uf, ano_eleicao, pessoa:pessoa_id(slug, nome_civil)"
    )
    .eq("oculto", false)
    .or(
      `nm_urna.ilike.%${termoLimpo}%,sg_partido.ilike.%${termoLimpo}%,nr_candidato.eq.${termoLimpo}`
    )
    .order("ano_eleicao", { ascending: false })
    .limit(20);

  if (error) throw error;

  const vistos = new Set<string>();
  const resultados: ResultadoBusca[] = [];
  for (const linha of (data ?? []) as unknown as LinhaBusca[]) {
    if (!linha.pessoa || vistos.has(linha.pessoa_id)) continue;
    vistos.add(linha.pessoa_id);
    resultados.push({
      pessoaId: linha.pessoa_id,
      slug: linha.pessoa.slug,
      nome: linha.pessoa.nome_civil,
      cargoMaisRecente: linha.cargo,
      partido: linha.sg_partido,
      uf: linha.sg_uf,
    });
  }
  return resultados;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npx vitest run lib/busca.test.ts
```

Esperado: PASS, 2 testes.

- [ ] **Step 5: Página de busca**

```tsx
// app/page.tsx
import Link from "next/link";
import { buscarPoliticos } from "@/lib/busca";

export default async function PaginaBusca({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const resultados = q ? await buscarPoliticos(q) : [];

  return (
    <main>
      <h1>RaioX Brasília</h1>
      <form>
        <input type="text" name="q" defaultValue={q} placeholder="Nome, número ou partido" />
        <button type="submit">Buscar</button>
      </form>
      <ul>
        {resultados.map((r) => (
          <li key={r.pessoaId}>
            <Link href={`/politico/${r.slug}`}>
              {r.nome} — {r.cargoMaisRecente} — {r.partido}/{r.uf}
            </Link>
          </li>
        ))}
      </ul>
      {q && resultados.length === 0 && <p>Nenhum político encontrado para "{q}".</p>}
    </main>
  );
}
```

- [ ] **Step 6: Verificação manual**

```bash
npm run dev
```

Acesse `http://localhost:3000/?q=Teste`. Esperado: nada aparece ainda (banco está vazio até o Task 10 rodar a ingestão real) — confirme apenas que a página carrega sem erro.

- [ ] **Step 7: Commit**

```bash
git add lib/busca.ts lib/busca.test.ts app/page.tsx
git commit -m "feat(busca): busca por nome, número de candidato ou partido"
```

---

### Task 8: Ficha do político

**Files:**
- Create: `raiox-brasilia/lib/ficha.ts`
- Test: `raiox-brasilia/lib/ficha.test.ts`
- Create: `raiox-brasilia/app/politico/[slug]/page.tsx`

- [ ] **Step 1: Escrever o teste (vai falhar — módulo ainda não existe)**

```ts
// lib/ficha.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { supabaseServidor } from "./supabase/server";
import { buscarFicha } from "./ficha";

const SLUG_TESTE = "candidato-teste-ficha-3a2b1c";

beforeAll(async () => {
  const { data: pessoa, error } = await supabaseServidor
    .from("pessoa")
    .insert({ slug: SLUG_TESTE, nome_civil: "Candidato Teste Ficha" })
    .select("id")
    .single();
  if (error) throw error;

  const { error: erroCandidatura } = await supabaseServidor.from("candidatura").insert({
    pessoa_id: pessoa.id,
    ano_eleicao: 2026,
    turno: 1,
    cargo: "SENADOR",
    sg_uf: "RR",
    nr_candidato: "88888",
    nm_urna: "CANDIDATO TESTE FICHA",
    sg_partido: "PTB",
    situacao: "ELEITO",
    sq_candidato_tse: "999999999999994",
    fonte_url: "https://teste.local",
  });
  if (erroCandidatura) throw erroCandidatura;
});

afterAll(async () => {
  await supabaseServidor.from("candidatura").delete().eq("sq_candidato_tse", "999999999999994");
  await supabaseServidor.from("pessoa").delete().eq("slug", SLUG_TESTE);
});

describe("buscarFicha", () => {
  it("retorna pessoa e suas candidaturas", async () => {
    const ficha = await buscarFicha(SLUG_TESTE);
    expect(ficha?.nome).toBe("Candidato Teste Ficha");
    expect(ficha?.candidaturas).toHaveLength(1);
    expect(ficha?.candidaturas[0].cargo).toBe("SENADOR");
    expect(ficha?.candidaturas[0].fonteUrl).toBe("https://teste.local");
  });

  it("retorna null para slug inexistente", async () => {
    const ficha = await buscarFicha("nao-existe-999999");
    expect(ficha).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run lib/ficha.test.ts
```

Esperado: FAIL, `Cannot find module './ficha'`.

- [ ] **Step 3: Implementar**

```ts
// lib/ficha.ts
import { supabaseServidor } from "./supabase/server";

export interface FichaPolitico {
  nome: string;
  candidaturas: {
    anoEleicao: number;
    cargo: string;
    sgUf: string;
    sgPartido: string;
    situacao: string;
    fonteUrl: string;
    coletadoEm: string;
  }[];
}

export async function buscarFicha(slug: string): Promise<FichaPolitico | null> {
  const { data: pessoa, error: erroPessoa } = await supabaseServidor
    .from("pessoa")
    .select("id, nome_civil")
    .eq("slug", slug)
    .eq("oculto", false)
    .maybeSingle();
  if (erroPessoa) throw erroPessoa;
  if (!pessoa) return null;

  const { data: candidaturas, error: erroCandidaturas } = await supabaseServidor
    .from("candidatura")
    .select("ano_eleicao, cargo, sg_uf, sg_partido, situacao, fonte_url, coletado_em")
    .eq("pessoa_id", pessoa.id)
    .eq("oculto", false)
    .order("ano_eleicao", { ascending: false });
  if (erroCandidaturas) throw erroCandidaturas;

  return {
    nome: pessoa.nome_civil,
    candidaturas: (candidaturas ?? []).map((c) => ({
      anoEleicao: c.ano_eleicao,
      cargo: c.cargo,
      sgUf: c.sg_uf,
      sgPartido: c.sg_partido,
      situacao: c.situacao ?? "Não divulgada",
      fonteUrl: c.fonte_url,
      coletadoEm: c.coletado_em,
    })),
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
npx vitest run lib/ficha.test.ts
```

Esperado: PASS, 2 testes.

- [ ] **Step 5: Página de ficha**

```tsx
// app/politico/[slug]/page.tsx
import { notFound } from "next/navigation";
import { buscarFicha } from "@/lib/ficha";

export default async function PaginaFicha({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ficha = await buscarFicha(slug);
  if (!ficha) notFound();

  const emailContato = process.env.NEXT_PUBLIC_EMAIL_CONTATO;
  const assuntoEmail = encodeURIComponent(`Correção na ficha: ${ficha.nome}`);

  return (
    <main>
      <h1>{ficha.nome}</h1>
      <section>
        <h2>Candidaturas</h2>
        {ficha.candidaturas.length === 0 ? (
          <p>Sem candidatura registrada.</p>
        ) : (
          <ul>
            {ficha.candidaturas.map((c) => (
              <li key={`${c.anoEleicao}-${c.cargo}`}>
                {c.anoEleicao} — {c.cargo} ({c.sgUf}) — {c.sgPartido} — {c.situacao}
                <br />
                <small>
                  fonte: <a href={c.fonteUrl}>{c.fonteUrl}</a>, coletado em{" "}
                  {new Date(c.coletadoEm).toLocaleDateString("pt-BR")}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      {emailContato && (
        <footer>
          <a href={`mailto:${emailContato}?subject=${assuntoEmail}`}>
            Encontrou um erro nesta ficha? Reporte aqui.
          </a>
        </footer>
      )}
    </main>
  );
}
```

`NEXT_PUBLIC_EMAIL_CONTATO` precisa estar em `.env.local` (Task 1) — sem ele, o link de correção some da página (checagem `emailContato &&`), então não esqueça de preencher antes de considerar o v1 pronto.

- [ ] **Step 6: Commit**

```bash
git add lib/ficha.ts lib/ficha.test.ts "app/politico/[slug]/page.tsx"
git commit -m "feat(ficha): página de ficha do político com seção de candidaturas e canal de correção"
```

---

### Task 9: Deploy

**Files:** nenhum arquivo novo — configuração de infraestrutura.

- [ ] **Step 1: Criar projeto na Vercel**

No painel Vercel (`https://vercel.com/new`): importar o repositório `raiox-brasilia`. Framework detectado automaticamente como Next.js.

- [ ] **Step 2: Configurar variáveis de ambiente na Vercel**

Em Settings → Environment Variables do projeto Vercel, adicionar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` com os mesmos valores do `.env.local`.

- [ ] **Step 3: Deploy**

```bash
git push origin master
```

A Vercel builda automaticamente a partir do push. Confira o log de build no painel — esperado: build verde, URL tipo `raiox-brasilia.vercel.app` funcionando.

- [ ] **Step 4: Domínio**

Comprar/usar domínio já registrado no registro.br. Em Settings → Domains do projeto Vercel, adicionar o domínio. Seguir a mesma cautela já usada em outros projetos: registro **A** só no apex, sem tocar em registro **MX** (e-mail) existente.

---

### Task 10: QA manual final

- [ ] **Step 1: Rodar a ingestão real**

```bash
npx tsx scripts/ingest/tse/ingest_candidatura.ts
```

Esperado: log final `Concluído: N candidatura(s) processada(s)`, sem `falhou`.

- [ ] **Step 2: Conferir 5 políticos conhecidos manualmente**

Escolha 5 nomes conhecidos (candidatos a governador ou senador de qualquer estado), busque cada um no site (`/?q=<nome>`), abra a ficha, e confira cargo/partido/UF/situação contra o portal oficial `https://divulgacandcontas.tse.jus.br`. Registrar aqui qualquer divergência encontrada antes de considerar este plano concluído.

- [ ] **Step 3: Confirmar seção "sem dado" funciona**

Escolha um político cuja candidatura tenha `situacao` nula na fonte original — confirme que a ficha mostra "Não divulgada" em vez de quebrar ou mostrar `null`.

---

## Próximos planos (fora deste escopo)

- Plano 2: Financiamento de campanha (TSE prestação de contas).
- Plano 3: Votação nominal (Câmara/Senado).
- Plano 4: Processos judiciais (CNJ DataJud, com filtro de sigilo).
- Plano 5: Apoio formal (coligação + doação) e polish de SEO/sitemap.

Cada um adiciona uma seção nova na mesma ficha — arquitetura de dado e identidade de pessoa já ficam prontas neste Plano 1.
