# CV Tailor — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Fase 1 CV Tailor web app: a master data bank of André's real achievements, a pipeline that generates an ATS-safe, job-mirrored `.docx` résumé plus likely interview questions for any specific job posting, and a searchable application tracker.

**Architecture:** Next.js (App Router) on Vercel, Supabase (Postgres + Storage) for all data, Claude API (Anthropic) called server-side only. The résumé is never "written" by the model directly — the model returns structured JSON, and a deterministic renderer injects it into a plain single-column `.docx` template (no tables, no text boxes, no unicode bullets), guaranteeing by construction that the parsing failures found in the CV audit cannot reappear.

**Tech Stack:** Next.js 15 (App Router, TypeScript), React 19, @supabase/supabase-js, @anthropic-ai/sdk, docx (npm), zod, Vitest for unit tests, tsx for the one-shot import script.

**Spec:** `docs/superpowers/specs/2026-09-12-cv-generator-design.md`

---

## File Structure

```
cv-tailor/
  package.json
  tsconfig.json
  next.config.mjs
  vitest.config.ts
  .gitignore
  .env.example
  supabase/
    migrations/
      0001_init.sql
  src/
    app/
      layout.tsx
      globals.css
      page.tsx                        # dashboard: list + search applications
      applications/
        new/page.tsx                  # ingestion form
        [id]/page.tsx                 # confirm job text -> generate -> view result
      actions/
        create-application.ts         # server action: store a new application draft
        generate-cv.ts                # server action: wires runCvGeneration with real deps
        update-status.ts              # server action: update application status
    lib/
      types.ts                        # shared TS interfaces matching the schema
      constants.ts                    # DEFAULT_USER_ID and other fixed config
      generation-schema.ts            # zod schema + parseGeneratedCv
      docx-template.ts                # renderCvDocx (deterministic, ATS-safe)
      claude-generation.ts            # buildGenerationPrompt, assertAchievementsAreReal, generateTailoredCv
      generate-cv-orchestrator.ts     # runCvGeneration (pure, dependency-injected)
      extract-job-text.ts             # extractTextFromHtml, fetchJobDescription
      repository.ts                   # Supabase CRUD wrappers
      storage.ts                      # uploadCvDocx
      supabase/
        server.ts                     # service-role Supabase client (server-only)
  scripts/
    import-cv.ts                      # one-shot: parse existing CV PDFs into the master data bank
  tests/
    generation-schema.test.ts
    docx-template.test.ts
    claude-generation.test.ts
    generate-cv-orchestrator.test.ts
    extract-job-text.test.ts
```

Each `lib/` file has one responsibility and is either a pure function (unit-tested directly) or a thin I/O wrapper (Supabase/Storage/Anthropic clients), isolated so the orchestrator and generation logic never touch a network client directly — they receive dependencies as arguments, which is what makes Task 8's core pipeline testable without mocking modules.

---

### Task 1: Project scaffold

**Files:**
- Create: `cv-tailor/package.json`
- Create: `cv-tailor/tsconfig.json`
- Create: `cv-tailor/next.config.mjs`
- Create: `cv-tailor/vitest.config.ts`
- Create: `cv-tailor/.gitignore`
- Create: `cv-tailor/.env.example`
- Create: `cv-tailor/src/app/layout.tsx`
- Create: `cv-tailor/src/app/globals.css`
- Create: `cv-tailor/src/app/page.tsx`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cv-tailor",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "import-cv": "tsx scripts/import-cv.ts"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@supabase/supabase-js": "^2.45.0",
    "@anthropic-ai/sdk": "^0.32.0",
    "docx": "^9.0.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "vitest": "^2.1.0",
    "jszip": "^3.10.1",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run (from `F:\RichClub\cv-tailor`): `npm install`
Expected: installs without error, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {}
export default nextConfig
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules
.next
.env.local
```

- [ ] **Step 7: Create `.env.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
```

- [ ] **Step 8: Create `src/app/globals.css`**

```css
:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, sans-serif; }
```

- [ ] **Step 9: Create `src/app/layout.tsx`**

```tsx
import './globals.css'

export const metadata = { title: 'CV Tailor' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 10: Create `src/app/page.tsx` (placeholder, replaced in Task 11)**

```tsx
export default function HomePage() {
  return <main style={{ padding: 24 }}><h1>CV Tailor</h1></main>
}
```

- [ ] **Step 11: Verify the project builds**

Run: `npm run build`
Expected: `Compiled successfully` (env vars are not read at build time by this placeholder page, so no `.env.local` is needed yet).

- [ ] **Step 12: Commit**

```bash
git add cv-tailor/package.json cv-tailor/package-lock.json cv-tailor/tsconfig.json cv-tailor/next.config.mjs cv-tailor/vitest.config.ts cv-tailor/.gitignore cv-tailor/.env.example cv-tailor/src
git commit -m "feat(cv-tailor): scaffold Next.js project"
```

---

### Task 2: Supabase schema and storage bucket

**Files:**
- Create: `cv-tailor/supabase/migrations/0001_init.sql`

- [ ] **Step 1: Write the migration**

```sql
create extension if not exists pgcrypto;

create table profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  full_name text not null,
  email text not null,
  phone text,
  location text,
  linkedin_url text,
  github_url text,
  created_at timestamptz not null default now()
);

create table achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  company text not null,
  role_title text not null,
  start_date date not null,
  end_date date,
  bullet text not null,
  metric text,
  positioning text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  institution text not null,
  degree text not null,
  completed_on date,
  in_progress boolean not null default false,
  positioning text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  issuer text,
  issued_on date,
  positioning text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  category text not null,
  positioning text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  company text not null,
  role_title text not null,
  source_url text,
  job_description_raw text not null,
  status text not null default 'sem_resposta' check (status in ('sem_resposta','rejeitado','entrevista','oferta')),
  applied_at date not null default current_date,
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    to_tsvector('portuguese', coalesce(company,'') || ' ' || coalesce(role_title,'') || ' ' || coalesce(job_description_raw,''))
  ) stored
);

create index applications_search_idx on applications using gin (search_vector);
create index applications_user_idx on applications (user_id);

create table cv_versions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  storage_path text not null,
  generated_json jsonb not null,
  created_at timestamptz not null default now()
);

create table interview_questions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  question text not null,
  rationale text not null,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Apply the migration**

If a Supabase project for this doesn't exist yet: create one at supabase.com/dashboard (free tier is enough for Fase 1). Then, in the project's SQL Editor, paste the full contents of `0001_init.sql` and click Run.
Expected: "Success. No rows returned."

- [ ] **Step 3: Verify the tables exist**

In the SQL Editor, run: `select table_name from information_schema.tables where table_schema = 'public' order by 1;`
Expected: `achievements`, `applications`, `certifications`, `cv_versions`, `education`, `interview_questions`, `profile`, `skills`.

- [ ] **Step 4: Create the storage bucket**

In the Supabase dashboard: Storage → New bucket → name `cv-files` → Private bucket (not public) → Create.

- [ ] **Step 5: Record the connection details**

Copy Project URL and `service_role` key (Settings → API) into `cv-tailor/.env.local` (create this file, it is gitignored):

```
NEXT_PUBLIC_SUPABASE_URL=<project-url>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
ANTHROPIC_API_KEY=<anthropic-key>
```

- [ ] **Step 6: Commit the migration file**

```bash
git add cv-tailor/supabase/migrations/0001_init.sql
git commit -m "feat(cv-tailor): add initial Postgres schema"
```

---

### Task 3: Shared types and the generation schema

**Files:**
- Create: `cv-tailor/src/lib/constants.ts`
- Create: `cv-tailor/src/lib/types.ts`
- Create: `cv-tailor/src/lib/generation-schema.ts`
- Test: `cv-tailor/tests/generation-schema.test.ts`

- [ ] **Step 1: Create `src/lib/constants.ts`**

```ts
// Fase 1 has a single user (André). Every table already has user_id so
// Fase 2 can add real auth without a schema migration.
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001'
```

- [ ] **Step 2: Create `src/lib/types.ts`**

```ts
export type Positioning = 'TPM' | 'AI Product' | 'Web3'

export interface Profile {
  id: string
  user_id: string
  full_name: string
  email: string
  phone: string | null
  location: string | null
  linkedin_url: string | null
  github_url: string | null
}

export interface Achievement {
  id: string
  user_id: string
  company: string
  role_title: string
  start_date: string
  end_date: string | null
  bullet: string
  metric: string | null
  positioning: Positioning[]
}

export interface Skill {
  id: string
  user_id: string
  name: string
  category: string
  positioning: Positioning[]
}

export interface Education {
  id: string
  user_id: string
  institution: string
  degree: string
  completed_on: string | null
  in_progress: boolean
  positioning: Positioning[]
}

export interface Certification {
  id: string
  user_id: string
  name: string
  issuer: string | null
  issued_on: string | null
  positioning: Positioning[]
}

export interface MasterDataBank {
  achievements: Achievement[]
  skills: Skill[]
  education: Education[]
  certifications: Certification[]
}

export type ApplicationStatus = 'sem_resposta' | 'rejeitado' | 'entrevista' | 'oferta'

export interface Application {
  id: string
  user_id: string
  company: string
  role_title: string
  source_url: string | null
  job_description_raw: string
  status: ApplicationStatus
  applied_at: string
  created_at: string
}
```

- [ ] **Step 3: Write the failing test for the generation schema**

```ts
// tests/generation-schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseGeneratedCv } from '../src/lib/generation-schema'

const validJson = JSON.stringify({
  headline: 'Technical Program Manager',
  summary: 'Summary text',
  selectedAchievements: [{ company: 'Delirio Tropical', roleTitle: 'IT Manager', bullet: 'Reduced COGS by 5%' }],
  keywords: ['SAP B1', 'Agile'],
  interviewQuestions: [{ question: 'Tell me about a time you led a cross-functional program', rationale: 'Matches the "cross-functional" requirement in the posting' }],
})

describe('parseGeneratedCv', () => {
  it('parses a valid JSON string into a GeneratedCv', () => {
    const result = parseGeneratedCv(validJson)
    expect(result.headline).toBe('Technical Program Manager')
    expect(result.selectedAchievements).toHaveLength(1)
  })

  it('throws when a required field is missing', () => {
    const missingKeywords = JSON.stringify({
      headline: 'X', summary: 'Y', selectedAchievements: [], interviewQuestions: [],
    })
    expect(() => parseGeneratedCv(missingKeywords)).toThrow()
  })

  it('throws when the input is not valid JSON', () => {
    expect(() => parseGeneratedCv('not json at all')).toThrow()
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- generation-schema`
Expected: FAIL — `Cannot find module '../src/lib/generation-schema'`.

- [ ] **Step 5: Create `src/lib/generation-schema.ts`**

```ts
import { z } from 'zod'

export const generatedCvSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  selectedAchievements: z.array(z.object({
    company: z.string().min(1),
    roleTitle: z.string().min(1),
    bullet: z.string().min(1),
  })),
  keywords: z.array(z.string().min(1)),
  interviewQuestions: z.array(z.object({
    question: z.string().min(1),
    rationale: z.string().min(1),
  })),
})

export type GeneratedCv = z.infer<typeof generatedCvSchema>

export function parseGeneratedCv(raw: string): GeneratedCv {
  const json = JSON.parse(raw)
  return generatedCvSchema.parse(json)
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- generation-schema`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add cv-tailor/src/lib/constants.ts cv-tailor/src/lib/types.ts cv-tailor/src/lib/generation-schema.ts cv-tailor/tests/generation-schema.test.ts
git commit -m "feat(cv-tailor): add shared types and generated-CV schema"
```

---

### Task 4: DOCX renderer — the ATS-safety guarantee

This is the task that encodes the CV audit findings directly: the renderer only ever calls `Paragraph`/`TextRun` from `docx`, never `Table` or a text box, so the two structural failures found in the audit (colored header block, bordered projects table) are impossible by construction, not by prompting. The test asserts this against the actual generated XML, not just against the code that produced it.

**Files:**
- Create: `cv-tailor/src/lib/docx-template.ts`
- Test: `cv-tailor/tests/docx-template.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/docx-template.test.ts
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { renderCvDocx } from '../src/lib/docx-template'
import type { Profile } from '../src/lib/types'
import type { GeneratedCv } from '../src/lib/generation-schema'

const profile: Profile = {
  id: '1', user_id: '1', full_name: 'André Dias Moreira Prol', email: 'andreprol@andreprol.com.br',
  phone: '+55 (21) 97558-9767', location: 'Rio de Janeiro, Brazil', linkedin_url: 'linkedin.com/in/andre-dias-moreira-prol', github_url: 'github.com/andreprol',
}

const content: GeneratedCv = {
  headline: 'Technical Program Manager',
  summary: 'Summary text for this role.',
  selectedAchievements: [
    { company: 'Delirio Tropical', roleTitle: 'IT Manager', bullet: 'Reduced Cost of Goods Sold by 5%, generating ~R$5MM/year in savings.' },
  ],
  keywords: ['Agile', 'SAP Business One', 'Stakeholder Management'],
  interviewQuestions: [{ question: 'Q1', rationale: 'R1' }],
}

async function documentXmlOf(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('word/document.xml')!.async('string')
}

describe('renderCvDocx', () => {
  it('produces a non-empty docx buffer', async () => {
    const buffer = await renderCvDocx(profile, content)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('never emits a table or a text box', async () => {
    const xml = await documentXmlOf(await renderCvDocx(profile, content))
    expect(xml).not.toContain('<w:tbl')
    expect(xml).not.toContain('w:txbxContent')
  })

  it('includes the achievement bullet as plain text', async () => {
    const xml = await documentXmlOf(await renderCvDocx(profile, content))
    expect(xml).toContain('Reduced Cost of Goods Sold by 5')
  })

  it('mirrors the job-matched headline and contact info as plain paragraphs', async () => {
    const xml = await documentXmlOf(await renderCvDocx(profile, content))
    expect(xml).toContain('Technical Program Manager')
    expect(xml).toContain('andreprol@andreprol.com.br')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- docx-template`
Expected: FAIL — `Cannot find module '../src/lib/docx-template'`.

- [ ] **Step 3: Create `src/lib/docx-template.ts`**

```ts
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import type { Profile } from './types'
import type { GeneratedCv } from './generation-schema'

export async function renderCvDocx(profile: Profile, content: GeneratedCv): Promise<Buffer> {
  const contactLine = [profile.location, profile.phone, profile.email, profile.linkedin_url, profile.github_url]
    .filter(Boolean)
    .join(' | ')

  const experienceParagraphs = content.selectedAchievements.flatMap((achievement) => [
    new Paragraph({
      children: [new TextRun({ text: `${achievement.roleTitle} - ${achievement.company}`, bold: true })],
    }),
    new Paragraph({ text: `- ${achievement.bullet}` }),
  ])

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: profile.full_name, heading: HeadingLevel.TITLE }),
          new Paragraph({ text: content.headline }),
          new Paragraph({ text: contactLine }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Professional Summary', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: content.summary }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Work Experience', heading: HeadingLevel.HEADING_1 }),
          ...experienceParagraphs,
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Skills', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: content.keywords.join(', ') }),
        ],
      },
    ],
  })

  return Packer.toBuffer(doc)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- docx-template`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cv-tailor/src/lib/docx-template.ts cv-tailor/tests/docx-template.test.ts
git commit -m "feat(cv-tailor): add ATS-safe deterministic docx renderer"
```

---

### Task 5: Claude generation — prompt, anti-hallucination guard, retry

**Files:**
- Create: `cv-tailor/src/lib/claude-generation.ts`
- Test: `cv-tailor/tests/claude-generation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/claude-generation.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildGenerationPrompt, assertAchievementsAreReal, generateTailoredCv } from '../src/lib/claude-generation'
import type { MasterDataBank } from '../src/lib/types'

const masterData: MasterDataBank = {
  achievements: [
    { id: '1', user_id: '1', company: 'Delirio Tropical', role_title: 'IT Manager', start_date: '2014-10-01', end_date: null, bullet: 'Reduced Cost of Goods Sold by 5%.', metric: '5%', positioning: ['TPM'] },
  ],
  skills: [{ id: '1', user_id: '1', name: 'SAP Business One', category: 'ERP', positioning: ['TPM'] }],
  education: [],
  certifications: [],
}

describe('buildGenerationPrompt', () => {
  it('includes the job description and the real achievement bullet', () => {
    const prompt = buildGenerationPrompt(masterData, 'Vaga de Technical Program Manager remoto')
    expect(prompt).toContain('Vaga de Technical Program Manager remoto')
    expect(prompt).toContain('Reduced Cost of Goods Sold by 5%.')
  })

  it('instructs the model to never invent an achievement', () => {
    const prompt = buildGenerationPrompt(masterData, 'Vaga qualquer')
    expect(prompt.toLowerCase()).toContain('nunca invente')
  })
})

describe('assertAchievementsAreReal', () => {
  it('throws when a selected bullet is not in the master data', () => {
    const generated = { selectedAchievements: [{ company: 'X', roleTitle: 'Y', bullet: 'Invented achievement' }] } as any
    expect(() => assertAchievementsAreReal(masterData, generated)).toThrow(/alucina/)
  })

  it('does not throw when every selected bullet is real', () => {
    const generated = { selectedAchievements: [{ company: 'Delirio Tropical', roleTitle: 'IT Manager', bullet: 'Reduced Cost of Goods Sold by 5%.' }] } as any
    expect(() => assertAchievementsAreReal(masterData, generated)).not.toThrow()
  })
})

describe('generateTailoredCv', () => {
  it('retries once when the first response fails validation, then returns the valid result', async () => {
    const goodJson = JSON.stringify({
      headline: 'Technical Program Manager',
      summary: 'Summary',
      selectedAchievements: [{ company: 'Delirio Tropical', roleTitle: 'IT Manager', bullet: 'Reduced Cost of Goods Sold by 5%.' }],
      keywords: ['SAP Business One'],
      interviewQuestions: [{ question: 'Q1', rationale: 'R1' }],
    })
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: goodJson }] })
    const fakeClient = { messages: { create } } as any

    const result = await generateTailoredCv(fakeClient, masterData, 'Vaga TPM')

    expect(create).toHaveBeenCalledTimes(2)
    expect(result.headline).toBe('Technical Program Manager')
  })

  it('propagates the error when both attempts fail', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] })
    const fakeClient = { messages: { create } } as any

    await expect(generateTailoredCv(fakeClient, masterData, 'Vaga TPM')).rejects.toThrow()
    expect(create).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- claude-generation`
Expected: FAIL — `Cannot find module '../src/lib/claude-generation'`.

- [ ] **Step 3: Create `src/lib/claude-generation.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk'
import { parseGeneratedCv, type GeneratedCv } from './generation-schema'
import type { MasterDataBank } from './types'

export function buildGenerationPrompt(masterData: MasterDataBank, jobDescription: string): string {
  const achievementLines = masterData.achievements
    .map((a) => `- [${a.positioning.join('/')}] ${a.role_title} @ ${a.company}: ${a.bullet}`)
    .join('\n')
  const skillLines = masterData.skills.map((s) => `- [${s.positioning.join('/')}] ${s.name}`).join('\n')

  return `Voce e um especialista em recrutamento tecnico e ATS. Gere um curriculo customizado pra vaga abaixo usando SOMENTE as conquistas e skills reais listadas no banco de dados. NUNCA invente conquista, metrica ou skill que nao esteja literalmente listada abaixo.

BANCO DE DADOS REAL:
Conquistas:
${achievementLines}

Skills:
${skillLines}

VAGA:
${jobDescription}

Regras obrigatorias:
1. O campo "headline" deve espelhar o titulo exato do cargo da vaga.
2. Cada item de "selectedAchievements" deve copiar o campo "bullet" LITERALMENTE de uma das conquistas listadas acima, sem parafrasear.
3. "keywords" deve listar os termos tecnicos exatos que aparecem na vaga e que tambem aparecem no banco de dados.
4. Se nao houver conquista real o suficiente pra essa vaga, retorne o que houver de mais proximo — nunca invente uma nova.
5. Gere tambem "interviewQuestions": 5 perguntas provaveis de entrevista pra essa vaga especifica, cada uma com "rationale" explicando por que essa pergunta e provavel pra essa vaga.

Responda APENAS com um JSON no formato exato:
{"headline": "...", "summary": "...", "selectedAchievements": [{"company": "...", "roleTitle": "...", "bullet": "..."}], "keywords": ["..."], "interviewQuestions": [{"question": "...", "rationale": "..."}]}`
}

export function assertAchievementsAreReal(masterData: MasterDataBank, generated: Pick<GeneratedCv, 'selectedAchievements'>): void {
  const realBullets = new Set(masterData.achievements.map((a) => a.bullet))
  for (const selected of generated.selectedAchievements) {
    if (!realBullets.has(selected.bullet)) {
      throw new Error(`Conquista nao encontrada no banco mestre (possivel alucinacao): "${selected.bullet}"`)
    }
  }
}

async function callOnce(client: Anthropic, masterData: MasterDataBank, jobDescription: string): Promise<GeneratedCv> {
  const prompt = buildGenerationPrompt(masterData, jobDescription)
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = response.content[0]
  const text = block.type === 'text' ? block.text : ''
  const parsed = parseGeneratedCv(text)
  assertAchievementsAreReal(masterData, parsed)
  return parsed
}

export async function generateTailoredCv(client: Anthropic, masterData: MasterDataBank, jobDescription: string): Promise<GeneratedCv> {
  try {
    return await callOnce(client, masterData, jobDescription)
  } catch {
    return await callOnce(client, masterData, jobDescription)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- claude-generation`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add cv-tailor/src/lib/claude-generation.ts cv-tailor/tests/claude-generation.test.ts
git commit -m "feat(cv-tailor): add Claude generation with anti-hallucination guard and retry"
```

---

### Task 6: Supabase client and repository

These are thin CRUD wrappers over Supabase — no meaningful branching logic to unit test, and mocking the entire Supabase client to "test" a one-line `.insert()` call would be busywork, not verification. Correctness of this layer is checked with real data in Task 9's end-to-end manual run, against the real project created in Task 2.

**Files:**
- Create: `cv-tailor/src/lib/supabase/server.ts`
- Create: `cv-tailor/src/lib/repository.ts`

- [ ] **Step 1: Create `src/lib/supabase/server.ts`**

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase env vars ausentes: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, serviceRoleKey)
}
```

- [ ] **Step 2: Create `src/lib/repository.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Application, ApplicationStatus, MasterDataBank, Profile } from './types'

export async function getMasterDataBank(db: SupabaseClient, userId: string): Promise<MasterDataBank> {
  const [{ data: achievements }, { data: skills }, { data: education }, { data: certifications }] = await Promise.all([
    db.from('achievements').select('*').eq('user_id', userId),
    db.from('skills').select('*').eq('user_id', userId),
    db.from('education').select('*').eq('user_id', userId),
    db.from('certifications').select('*').eq('user_id', userId),
  ])
  return {
    achievements: achievements ?? [],
    skills: skills ?? [],
    education: education ?? [],
    certifications: certifications ?? [],
  }
}

export async function getProfile(db: SupabaseClient, userId: string): Promise<Profile> {
  const { data, error } = await db.from('profile').select('*').eq('user_id', userId).single()
  if (error) throw error
  return data
}

export async function createApplication(
  db: SupabaseClient,
  userId: string,
  input: { company: string; roleTitle: string; sourceUrl: string | null; jobDescriptionRaw: string },
): Promise<Application> {
  const { data, error } = await db
    .from('applications')
    .insert({
      user_id: userId,
      company: input.company,
      role_title: input.roleTitle,
      source_url: input.sourceUrl,
      job_description_raw: input.jobDescriptionRaw,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getApplication(db: SupabaseClient, applicationId: string): Promise<Application> {
  const { data, error } = await db.from('applications').select('*').eq('id', applicationId).single()
  if (error) throw error
  return data
}

export async function updateJobDescription(db: SupabaseClient, applicationId: string, jobDescriptionRaw: string): Promise<void> {
  const { error } = await db.from('applications').update({ job_description_raw: jobDescriptionRaw }).eq('id', applicationId)
  if (error) throw error
}

export async function saveCvVersion(db: SupabaseClient, applicationId: string, storagePath: string, generatedJson: unknown): Promise<void> {
  const { error } = await db.from('cv_versions').insert({ application_id: applicationId, storage_path: storagePath, generated_json: generatedJson })
  if (error) throw error
}

export async function saveInterviewQuestions(db: SupabaseClient, applicationId: string, questions: { question: string; rationale: string }[]): Promise<void> {
  const rows = questions.map((q) => ({ application_id: applicationId, question: q.question, rationale: q.rationale }))
  const { error } = await db.from('interview_questions').insert(rows)
  if (error) throw error
}

export async function listApplications(db: SupabaseClient, userId: string, search?: string): Promise<Application[]> {
  let query = db.from('applications').select('*').eq('user_id', userId).order('created_at', { ascending: false })
  if (search) {
    query = query.textSearch('search_vector', search, { type: 'websearch' })
  }
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function updateApplicationStatus(db: SupabaseClient, applicationId: string, status: ApplicationStatus): Promise<void> {
  const { error } = await db.from('applications').update({ status }).eq('id', applicationId)
  if (error) throw error
}

export async function getApplicationDetail(db: SupabaseClient, applicationId: string) {
  const [{ data: application, error: appError }, { data: cvVersion }, { data: interviewQuestions }] = await Promise.all([
    db.from('applications').select('*').eq('id', applicationId).single(),
    db.from('cv_versions').select('*').eq('application_id', applicationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('interview_questions').select('*').eq('application_id', applicationId),
  ])
  if (appError) throw appError
  return { application, cvVersion: cvVersion ?? null, interviewQuestions: interviewQuestions ?? [] }
}
```

- [ ] **Step 3: Commit**

```bash
git add cv-tailor/src/lib/supabase/server.ts cv-tailor/src/lib/repository.ts
git commit -m "feat(cv-tailor): add Supabase service client and repository"
```

---

### Task 7: Storage upload helper

**Files:**
- Create: `cv-tailor/src/lib/storage.ts`

- [ ] **Step 1: Create `src/lib/storage.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export async function uploadCvDocx(db: SupabaseClient, applicationId: string, buffer: Buffer): Promise<string> {
  const path = `${applicationId}.docx`
  const { error } = await db.storage.from('cv-files').upload(path, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    upsert: true,
  })
  if (error) throw error
  return path
}

export async function getCvDownloadUrl(db: SupabaseClient, storagePath: string): Promise<string> {
  const { data, error } = await db.storage.from('cv-files').createSignedUrl(storagePath, 60 * 10)
  if (error) throw error
  return data.signedUrl
}
```

- [ ] **Step 2: Commit**

```bash
git add cv-tailor/src/lib/storage.ts
git commit -m "feat(cv-tailor): add Supabase Storage upload/download helpers"
```

---

### Task 8: Generation orchestrator (dependency-injected, fully unit-tested)

This is the piece that wires the whole pipeline together, and it is deliberately written against an interface of injected functions rather than importing Supabase/Anthropic clients directly — that is what makes it possible to test the full control flow, including both error-handling branches from the spec, with plain fakes and no module mocking.

**Files:**
- Create: `cv-tailor/src/lib/generate-cv-orchestrator.ts`
- Test: `cv-tailor/tests/generate-cv-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/generate-cv-orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runCvGeneration, type GenerateCvDeps } from '../src/lib/generate-cv-orchestrator'

function makeDeps(overrides: Partial<GenerateCvDeps> = {}): GenerateCvDeps {
  return {
    getApplication: vi.fn().mockResolvedValue({ id: 'app-1', job_description_raw: 'vaga...' }),
    getMasterDataBank: vi.fn().mockResolvedValue({
      achievements: [{ bullet: 'Reduced Cost of Goods Sold by 5%.' }], skills: [], education: [], certifications: [],
    }),
    getProfile: vi.fn().mockResolvedValue({ full_name: 'André Prol' }),
    generateTailoredCv: vi.fn().mockResolvedValue({
      headline: 'TPM', summary: 'S', selectedAchievements: [], keywords: [], interviewQuestions: [{ question: 'Q1', rationale: 'R1' }],
    }),
    renderCvDocx: vi.fn().mockResolvedValue(Buffer.from('docx-bytes')),
    uploadCvDocx: vi.fn().mockResolvedValue('app-1.docx'),
    saveCvVersion: vi.fn().mockResolvedValue(undefined),
    saveInterviewQuestions: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as GenerateCvDeps
}

describe('runCvGeneration', () => {
  it('runs the full pipeline for an existing application', async () => {
    const deps = makeDeps()

    await runCvGeneration(deps, 'app-1')

    expect(deps.generateTailoredCv).toHaveBeenCalledWith(expect.objectContaining({ achievements: expect.any(Array) }), 'vaga...')
    expect(deps.uploadCvDocx).toHaveBeenCalledWith('app-1', Buffer.from('docx-bytes'))
    expect(deps.saveCvVersion).toHaveBeenCalledWith('app-1', 'app-1.docx', expect.any(Object))
    expect(deps.saveInterviewQuestions).toHaveBeenCalledWith('app-1', [{ question: 'Q1', rationale: 'R1' }])
  })

  it('throws before calling Claude when the master data bank is empty', async () => {
    const deps = makeDeps({
      getMasterDataBank: vi.fn().mockResolvedValue({ achievements: [], skills: [], education: [], certifications: [] }),
    })

    await expect(runCvGeneration(deps, 'app-1')).rejects.toThrow('Banco mestre vazio')
    expect(deps.generateTailoredCv).not.toHaveBeenCalled()
  })

  it('propagates the error from generateTailoredCv without uploading anything', async () => {
    const deps = makeDeps({ generateTailoredCv: vi.fn().mockRejectedValue(new Error('Claude failed twice')) })

    await expect(runCvGeneration(deps, 'app-1')).rejects.toThrow('Claude failed twice')
    expect(deps.uploadCvDocx).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- generate-cv-orchestrator`
Expected: FAIL — `Cannot find module '../src/lib/generate-cv-orchestrator'`.

- [ ] **Step 3: Create `src/lib/generate-cv-orchestrator.ts`**

```ts
import type { GeneratedCv } from './generation-schema'
import type { Application, MasterDataBank, Profile } from './types'

export interface GenerateCvDeps {
  getApplication: (applicationId: string) => Promise<Application>
  getMasterDataBank: () => Promise<MasterDataBank>
  getProfile: () => Promise<Profile>
  generateTailoredCv: (masterData: MasterDataBank, jobDescription: string) => Promise<GeneratedCv>
  renderCvDocx: (profile: Profile, content: GeneratedCv) => Promise<Buffer>
  uploadCvDocx: (applicationId: string, buffer: Buffer) => Promise<string>
  saveCvVersion: (applicationId: string, storagePath: string, generatedJson: GeneratedCv) => Promise<void>
  saveInterviewQuestions: (applicationId: string, questions: GeneratedCv['interviewQuestions']) => Promise<void>
}

export async function runCvGeneration(deps: GenerateCvDeps, applicationId: string): Promise<void> {
  const application = await deps.getApplication(applicationId)

  const masterData = await deps.getMasterDataBank()
  if (masterData.achievements.length === 0) {
    throw new Error('Banco mestre vazio pra esse usuario — rode o importador antes de gerar um CV.')
  }

  const generated = await deps.generateTailoredCv(masterData, application.job_description_raw)
  const profile = await deps.getProfile()
  const docxBuffer = await deps.renderCvDocx(profile, generated)
  const storagePath = await deps.uploadCvDocx(applicationId, docxBuffer)

  await deps.saveCvVersion(applicationId, storagePath, generated)
  await deps.saveInterviewQuestions(applicationId, generated.interviewQuestions)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- generate-cv-orchestrator`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cv-tailor/src/lib/generate-cv-orchestrator.ts cv-tailor/tests/generate-cv-orchestrator.test.ts
git commit -m "feat(cv-tailor): add dependency-injected CV generation orchestrator"
```

---

### Task 9: Job posting extraction from a URL

Per the spec, link extraction is best-effort (plain `fetch` + HTML stripping, no headless browser, no anti-bot handling). Sites that block it — LinkedIn most likely will — fall through to the paste-text fallback in Task 10's form; this task only has to fail safely (return `null`), never throw into the UI.

**Files:**
- Create: `cv-tailor/src/lib/extract-job-text.ts`
- Test: `cv-tailor/tests/extract-job-text.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/extract-job-text.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractTextFromHtml, fetchJobDescription } from '../src/lib/extract-job-text'

describe('extractTextFromHtml', () => {
  it('strips tags, scripts and styles, and collapses whitespace', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><script>track()</script><h1>Senior TPM</h1><p>Remote   role.</p></body></html>'
    expect(extractTextFromHtml(html)).toBe('Senior TPM Remote role.')
  })
})

describe('fetchJobDescription', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the extracted text on a successful response with enough content', async () => {
    const longText = '<p>' + 'Senior Technical Program Manager remote role. '.repeat(10) + '</p>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(longText) }))

    const result = await fetchJobDescription('https://example.com/job/1')

    expect(result).toContain('Senior Technical Program Manager')
  })

  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') }))
    expect(await fetchJobDescription('https://example.com/blocked')).toBeNull()
  })

  it('returns null when the extracted text is too short to be a real posting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('<p>Login</p>') }))
    expect(await fetchJobDescription('https://example.com/login-wall')).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    expect(await fetchJobDescription('https://example.com/timeout')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- extract-job-text`
Expected: FAIL — `Cannot find module '../src/lib/extract-job-text'`.

- [ ] **Step 3: Create `src/lib/extract-job-text.ts`**

```ts
export function extractTextFromHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ')
  return withoutTags.replace(/\s+/g, ' ').trim()
}

const MIN_JOB_TEXT_LENGTH = 200

export async function fetchJobDescription(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!response.ok) return null
    const html = await response.text()
    const text = extractTextFromHtml(html)
    return text.length >= MIN_JOB_TEXT_LENGTH ? text : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- extract-job-text`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add cv-tailor/src/lib/extract-job-text.ts cv-tailor/tests/extract-job-text.test.ts
git commit -m "feat(cv-tailor): add best-effort job posting extraction from a URL"
```

---

### Task 10: Server actions

**Files:**
- Create: `cv-tailor/src/app/actions/create-application.ts`
- Create: `cv-tailor/src/app/actions/generate-cv.ts`
- Create: `cv-tailor/src/app/actions/update-status.ts`

No new automated tests here — these files only wire already-tested pieces (Tasks 5-9) to real Supabase/Anthropic clients via `runCvGeneration`'s dependency interface. Verified end-to-end in Task 13.

- [ ] **Step 1: Create `src/app/actions/create-application.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { createApplication } from '@/lib/repository'
import { fetchJobDescription } from '@/lib/extract-job-text'
import { DEFAULT_USER_ID } from '@/lib/constants'

export async function createApplicationAction(formData: FormData): Promise<void> {
  const company = String(formData.get('company') ?? '')
  const roleTitle = String(formData.get('roleTitle') ?? '')
  const sourceUrl = String(formData.get('sourceUrl') ?? '').trim() || null
  const pastedText = String(formData.get('jobDescriptionRaw') ?? '').trim()

  const jobDescriptionRaw = sourceUrl ? (await fetchJobDescription(sourceUrl)) ?? pastedText : pastedText

  if (!jobDescriptionRaw) {
    throw new Error('Nao foi possivel extrair o texto da vaga do link, e nenhum texto foi colado. Cole o texto da vaga manualmente.')
  }

  const db = createServiceClient()
  const application = await createApplication(db, DEFAULT_USER_ID, { company, roleTitle, sourceUrl, jobDescriptionRaw })

  redirect(`/applications/${application.id}`)
}
```

- [ ] **Step 2: Create `src/app/actions/generate-cv.ts`**

```ts
'use server'

import Anthropic from '@anthropic-ai/sdk'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import * as repo from '@/lib/repository'
import { generateTailoredCv } from '@/lib/claude-generation'
import { renderCvDocx } from '@/lib/docx-template'
import { uploadCvDocx } from '@/lib/storage'
import { runCvGeneration } from '@/lib/generate-cv-orchestrator'
import { DEFAULT_USER_ID } from '@/lib/constants'

export async function generateCvAction(applicationId: string, editedJobDescription: string): Promise<void> {
  const db = createServiceClient()

  if (editedJobDescription.trim().length > 0) {
    await repo.updateJobDescription(db, applicationId, editedJobDescription.trim())
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  await runCvGeneration(
    {
      getApplication: (id) => repo.getApplication(db, id),
      getMasterDataBank: () => repo.getMasterDataBank(db, DEFAULT_USER_ID),
      getProfile: () => repo.getProfile(db, DEFAULT_USER_ID),
      generateTailoredCv: (masterData, jobDescription) => generateTailoredCv(anthropic, masterData, jobDescription),
      renderCvDocx: (profile, content) => renderCvDocx(profile, content),
      uploadCvDocx: (id, buffer) => uploadCvDocx(db, id, buffer),
      saveCvVersion: (id, storagePath, generatedJson) => repo.saveCvVersion(db, id, storagePath, generatedJson),
      saveInterviewQuestions: (id, questions) => repo.saveInterviewQuestions(db, id, questions),
    },
    applicationId,
  )

  revalidatePath(`/applications/${applicationId}`)
}
```

- [ ] **Step 3: Create `src/app/actions/update-status.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { updateApplicationStatus } from '@/lib/repository'
import type { ApplicationStatus } from '@/lib/types'

export async function updateStatusAction(applicationId: string, status: ApplicationStatus): Promise<void> {
  const db = createServiceClient()
  await updateApplicationStatus(db, applicationId, status)
  revalidatePath(`/applications/${applicationId}`)
  revalidatePath('/')
}
```

- [ ] **Step 4: Commit**

```bash
git add cv-tailor/src/app/actions
git commit -m "feat(cv-tailor): wire server actions for application intake, generation and status"
```

---

### Task 11: Ingestion page and application detail page

**Files:**
- Create: `cv-tailor/src/app/applications/new/page.tsx`
- Create: `cv-tailor/src/app/applications/[id]/page.tsx`

- [ ] **Step 1: Create `src/app/applications/new/page.tsx`**

```tsx
import { createApplicationAction } from '@/app/actions/create-application'

export default function NewApplicationPage() {
  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Nova candidatura</h1>
      <form action={createApplicationAction}>
        <label>
          Empresa
          <input name="company" required style={{ display: 'block', width: '100%' }} />
        </label>
        <label>
          Cargo (titulo exato da vaga)
          <input name="roleTitle" required style={{ display: 'block', width: '100%' }} />
        </label>
        <label>
          Link da vaga (opcional)
          <input name="sourceUrl" type="url" style={{ display: 'block', width: '100%' }} />
        </label>
        <label>
          Ou cole o texto da vaga aqui (obrigatorio se o link nao puder ser lido)
          <textarea name="jobDescriptionRaw" rows={10} style={{ display: 'block', width: '100%' }} />
        </label>
        <button type="submit">Continuar</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Create `src/app/applications/[id]/page.tsx`**

```tsx
import { createServiceClient } from '@/lib/supabase/server'
import { getApplicationDetail } from '@/lib/repository'
import { getCvDownloadUrl } from '@/lib/storage'
import { generateCvAction } from '@/app/actions/generate-cv'
import { updateStatusAction } from '@/app/actions/update-status'
import type { ApplicationStatus } from '@/lib/types'

const STATUS_OPTIONS: ApplicationStatus[] = ['sem_resposta', 'rejeitado', 'entrevista', 'oferta']

export default async function ApplicationDetailPage({ params }: { params: { id: string } }) {
  const db = createServiceClient()
  const { application, cvVersion, interviewQuestions } = await getApplicationDetail(db, params.id)

  async function regenerate(formData: FormData) {
    'use server'
    await generateCvAction(params.id, String(formData.get('jobDescriptionRaw') ?? ''))
  }

  async function setStatus(formData: FormData) {
    'use server'
    await updateStatusAction(params.id, formData.get('status') as ApplicationStatus)
  }

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>{application.role_title} — {application.company}</h1>

      <form action={setStatus}>
        <select name="status" defaultValue={application.status}>
          {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <button type="submit">Atualizar status</button>
      </form>

      <h2>Texto da vaga (confira antes de gerar)</h2>
      <form action={regenerate}>
        <textarea name="jobDescriptionRaw" rows={12} style={{ display: 'block', width: '100%' }} defaultValue={application.job_description_raw} />
        <button type="submit">{cvVersion ? 'Gerar de novo' : 'Gerar CV'}</button>
      </form>

      {cvVersion && (
        <>
          <h2>CV gerado</h2>
          <DownloadLink db={db} storagePath={cvVersion.storage_path} />

          <h2>Perguntas provaveis de entrevista</h2>
          <ul>
            {interviewQuestions.map((q: { id: string; question: string; rationale: string }) => (
              <li key={q.id}><strong>{q.question}</strong> — {q.rationale}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

async function DownloadLink({ db, storagePath }: { db: ReturnType<typeof createServiceClient>; storagePath: string }) {
  const url = await getCvDownloadUrl(db, storagePath)
  return <a href={url}>Baixar CV (.docx)</a>
}
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: `Compiled successfully` (build-time type check; the pages read `process.env` only at request time, so no `.env.local` is required for the build itself).

- [ ] **Step 4: Commit**

```bash
git add cv-tailor/src/app/applications
git commit -m "feat(cv-tailor): add job intake form and application detail page"
```

---

### Task 12: Dashboard with search

**Files:**
- Modify: `cv-tailor/src/app/page.tsx`

- [ ] **Step 1: Replace the placeholder dashboard**

```tsx
import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { listApplications } from '@/lib/repository'
import { DEFAULT_USER_ID } from '@/lib/constants'

export default async function DashboardPage({ searchParams }: { searchParams: { q?: string } }) {
  const db = createServiceClient()
  const applications = await listApplications(db, DEFAULT_USER_ID, searchParams.q)

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>CV Tailor</h1>
      <Link href="/applications/new">Nova candidatura</Link>

      <form>
        <input name="q" defaultValue={searchParams.q ?? ''} placeholder="Buscar por vaga, empresa..." />
        <button type="submit">Buscar</button>
      </form>

      <table>
        <thead>
          <tr><th>Empresa</th><th>Cargo</th><th>Status</th><th>Candidatado em</th></tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr key={app.id}>
              <td><Link href={`/applications/${app.id}`}>{app.company}</Link></td>
              <td>{app.role_title}</td>
              <td>{app.status}</td>
              <td>{app.applied_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: `Compiled successfully`.

- [ ] **Step 3: Commit**

```bash
git add cv-tailor/src/app/page.tsx
git commit -m "feat(cv-tailor): add searchable applications dashboard"
```

---

### Task 13: One-shot master data bank importer

Reads André's existing CV PDFs and asks Claude to extract structured achievements/education/certifications/skills into draft rows, tagged by positioning. Run once, by hand, not part of the app's request/response path.

**Files:**
- Create: `cv-tailor/scripts/import-cv.ts`

- [ ] **Step 1: Create `scripts/import-cv.ts`**

```ts
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '../src/lib/supabase/server'
import { DEFAULT_USER_ID } from '../src/lib/constants'

const CV_PATHS = [
  'F:/Particular/CV/CV_Andre_Prol_TCS_AI_TPM.pdf',
]

const EXTRACTION_PROMPT = `Extraia do curriculo em anexo TODAS as conquistas reais (bullet points de work experience), skills, formacao e certificacoes, como JSON no formato:
{"achievements": [{"company": "...", "roleTitle": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD ou null", "bullet": "texto exato do bullet", "metric": "numero/percentual citado ou null", "positioning": ["TPM"]}], "skills": [{"name": "...", "category": "...", "positioning": ["TPM"]}], "education": [{"institution": "...", "degree": "...", "completedOn": "YYYY-MM-DD ou null", "inProgress": false, "positioning": ["TPM"]}], "certifications": [{"name": "...", "issuer": "...", "issuedOn": "YYYY-MM-DD ou null", "positioning": ["TPM"]}]}
Copie o texto do bullet LITERALMENTE, sem reescrever. "positioning" e um array com uma ou mais de: "TPM", "AI Product", "Web3" — classifique pelo conteudo real do item, nao pelo CV de origem. Responda APENAS com o JSON.`

async function importOneCv(anthropic: Anthropic, path: string) {
  const fileBuffer = readFileSync(path)
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  })
  const block = response.content[0]
  const text = block.type === 'text' ? block.text : '{}'
  return JSON.parse(text)
}

async function main() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const db = createServiceClient()

  for (const path of CV_PATHS) {
    console.log(`Importando ${path}...`)
    const extracted = await importOneCv(anthropic, path)

    if (extracted.achievements?.length) {
      await db.from('achievements').insert(extracted.achievements.map((a: any) => ({
        user_id: DEFAULT_USER_ID, company: a.company, role_title: a.roleTitle,
        start_date: a.startDate, end_date: a.endDate, bullet: a.bullet, metric: a.metric, positioning: a.positioning,
      })))
    }
    if (extracted.skills?.length) {
      await db.from('skills').insert(extracted.skills.map((s: any) => ({
        user_id: DEFAULT_USER_ID, name: s.name, category: s.category, positioning: s.positioning,
      })))
    }
    if (extracted.education?.length) {
      await db.from('education').insert(extracted.education.map((e: any) => ({
        user_id: DEFAULT_USER_ID, institution: e.institution, degree: e.degree,
        completed_on: e.completedOn, in_progress: e.inProgress, positioning: e.positioning,
      })))
    }
    if (extracted.certifications?.length) {
      await db.from('certifications').insert(extracted.certifications.map((c: any) => ({
        user_id: DEFAULT_USER_ID, name: c.name, issuer: c.issuer, issued_on: c.issuedOn, positioning: c.positioning,
      })))
    }
    console.log(`OK: ${extracted.achievements?.length ?? 0} achievements, ${extracted.skills?.length ?? 0} skills importados.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 2: Insert the profile row once, by hand**

In the Supabase SQL Editor:

```sql
insert into profile (user_id, full_name, email, phone, location, linkedin_url, github_url)
values (
  '00000000-0000-0000-0000-000000000001',
  'André Dias Moreira Prol',
  'andreprol@andreprol.com.br',
  '+55 (21) 97558-9767',
  'Rio de Janeiro, Brazil',
  'linkedin.com/in/andre-dias-moreira-prol',
  'github.com/andreprol'
);
```

- [ ] **Step 3: Run the importer**

Run (from `cv-tailor/`): `npm run import-cv`
Expected: prints `Importando F:/Particular/CV/CV_Andre_Prol_TCS_AI_TPM.pdf...` then `OK: N achievements, M skills importados.` with N and M greater than zero.

- [ ] **Step 4: Review the imported rows**

In the SQL Editor: `select company, role_title, bullet, positioning from achievements order by created_at;`
Expected: one row per real bullet from the CV, `positioning` tagged `{TPM}` (this CV has no Web3 content, per the earlier audit — an empty or missing Web3 tag here is correct, not a bug). Manually fix or delete any row that looks wrong before using the app for real.

- [ ] **Step 5: Commit**

```bash
git add cv-tailor/scripts/import-cv.ts
git commit -m "feat(cv-tailor): add one-shot CV importer for the master data bank"
```

---

### Task 14: Deploy and end-to-end acceptance test

**Files:** none (configuration and manual verification only).

- [ ] **Step 1: Push to Vercel**

Connect the `cv-tailor` directory as a Vercel project (Vercel dashboard → Add New → Project → Import → set root directory to `cv-tailor`), set the three environment variables from `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) in the Vercel project settings, deploy.
Expected: deployment succeeds, the dashboard loads at the assigned Vercel URL.

- [ ] **Step 2: Generate CVs for 3-5 real job postings**

Using real postings André is currently considering (mix of TPM/AI Product and, if still active, Web3), for each one: `/applications/new` → paste link or text → confirm extracted text → `Gerar CV`.
Expected: each one produces a downloadable `.docx` and 5 interview questions, no error thrown.

- [ ] **Step 3: Validate every generated `.docx` survives copy-paste intact**

For each generated file: open it in Word or Google Docs, Select All, copy, paste into a plain-text editor (Notepad).
Expected: every achievement bullet, the headline, and the contact line appear as clean, readable text — nothing turns into garbled characters or disappears. This is the direct, concrete test against the ATS parsing research from this session; if anything breaks here, it means a regression in Task 4's renderer, not a documentation problem.

- [ ] **Step 4: Confirm the dashboard's response-rate view is usable**

Update the `status` field on at least one test application via the detail page, back on `/`.
Expected: the dashboard reflects the updated status; this is what will let André see a real, corrected response rate as candidaturas accumulate — the entire reason this project exists.

- [ ] **Step 5: Record the outcome in project memory**

Update `C:\Users\fileserver\.claude\projects\F--RichClub\memory\project_web3_emprego.md` with: the Vercel URL, confirmation the importer ran and how many achievements/skills were imported, and the result of the 3-5 real-posting validation.

---

## Plan Self-Review

- **Spec coverage:** banco mestre (Tasks 3, 6, 13) · geração ATS-safe (Tasks 4, 5, 8) · ingestão de vaga por link/texto (Task 9, 11) · rastreador pesquisável (Tasks 6, 12) · perguntas de entrevista (Tasks 5, 8, 11) · tratamento de erro (scraping falho → Task 9's `null` + Task 10's fallback to pasted text; JSON malformado → Task 5's retry, tested; banco vazio → Task 8's explicit throw, tested) · critério de sucesso (Task 14, Step 4) · decisão de RLS desligada com `user_id` presente (Task 2) — every section of the spec has a task.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; Task 6 and Task 10 explicitly state why they have no new automated tests instead of silently skipping the step.
- **Type consistency:** `GeneratedCv` (Task 3) is the single shape produced by `generateTailoredCv` (Task 5), consumed by `renderCvDocx` (Task 4) and `runCvGeneration` (Task 8) without renaming fields. `Application`/`ApplicationStatus`/`MasterDataBank`/`Profile` (Task 3) are the only types referenced in `repository.ts` (Task 6), the orchestrator (Task 8), the server actions (Task 10) and the pages (Task 11-12).
