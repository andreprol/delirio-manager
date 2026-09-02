# Uriverse3D — Fundação + Loja Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data foundation and public storefront for Uriverse3D — catalog, cart, checkout with automatic freight calculation, embedded Mercado Pago payment, order-confirmation and tracking emails, and the toggleable custom-order request form.

**Architecture:** Next.js 15 (App Router, TypeScript) on Vercel. Supabase (Postgres + Auth + Storage) as the single source of truth, accessed via `@supabase/ssr`. Mercado Pago Payment Bricks for embedded Pix/card checkout, confirmed authoritatively via webhook (never trust the client-side result alone). Melhor Envio REST API for freight quotes. Resend for transactional email.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Supabase (`@supabase/supabase-js`, `@supabase/ssr`), `mercadopago` (server SDK) + `@mercadopago/sdk-react` (Payment Brick), Resend, Zustand (cart state), Zod (validation), Vitest + Testing Library (unit/integration tests).

Spec: [`docs/superpowers/specs/2026-09-02-fundacao-loja-design.md`](../specs/2026-09-02-fundacao-loja-design.md)

---

## Task 0: Prerequisites — contas e credenciais (não é código)

Isso não é uma tarefa de TDD — é uma checklist de contas que **você** (André/Raquel) precisa criar antes do Task 1, porque criação de conta e senha é ação que a IA não pode fazer por vocês.

- [ ] Criar projeto no [Supabase](https://supabase.com) (plano free serve pra começar). Anotar: Project URL, `anon` key, `service_role` key (Settings → API).
- [ ] Criar conta [Mercado Pago Developers](https://www.mercadopago.com.br/developers) vinculada ao CNPJ da Software Innovations. Criar aplicação, pegar Access Token (sandbox e produção) e Public Key.
- [ ] Criar conta [Melhor Envio](https://melhorenvio.com.br), gerar token de API (usar sandbox.melhorenvio.com.br pra testes).
- [ ] Criar conta [Resend](https://resend.com), adicionar e verificar o domínio `uriverse3d.com.br` (registros DNS — precisa acesso ao DNS do domínio), gerar API Key.
- [ ] Confirmar número de WhatsApp oficial da Raquel pra loja (formato internacional, ex: `5521999999999`).

Quando tiver essas credenciais, me repassa e eu preencho o `.env.local` (Task 1) — nunca cole senha/token direto no chat se puder colar só no arquivo.

---

## Task 1: Scaffold do projeto Next.js

**Files:**
- Create: `uriverse3d/package.json` (via create-next-app)
- Create: `uriverse3d/.env.local.example`
- Create: `uriverse3d/.gitignore` (via create-next-app, confirmar `.env.local` ignorado)

- [ ] **Step 1: Criar o projeto**

Run:
```bash
cd F:/RichClub
npx create-next-app@latest uriverse3d --typescript --tailwind --app --eslint --src-dir=false --import-alias "@/*"
```

- [ ] **Step 2: Instalar dependências do projeto**

Run:
```bash
cd F:/RichClub/uriverse3d
npm install @supabase/supabase-js @supabase/ssr mercadopago @mercadopago/sdk-react resend zustand zod
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
```

- [ ] **Step 3: Configurar Vitest**

Create `uriverse3d/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
```

Add to `uriverse3d/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 4: Criar `.env.local.example`**

Create `uriverse3d/.env.local.example`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
MERCADOPAGO_ACCESS_TOKEN=
NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY=
MELHORENVIO_TOKEN=
MELHORENVIO_BASE_URL=https://sandbox.melhorenvio.com.br
RESEND_API_KEY=
EMAIL_FROM=contato@uriverse3d.com.br
NEXT_PUBLIC_WHATSAPP_NUMBER=
ORIGIN_CEP=22790672
SITE_URL=http://localhost:3000
```

- [ ] **Step 5: Rodar dev server e confirmar boot limpo**

Run: `npm run dev` (abrir http://localhost:3000, confirmar tela padrão do Next carrega, depois `Ctrl+C`).

- [ ] **Step 6: Commit**

```bash
cd F:/RichClub
git add uriverse3d/package.json uriverse3d/package-lock.json uriverse3d/tsconfig.json uriverse3d/vitest.config.ts uriverse3d/.env.local.example uriverse3d/.gitignore uriverse3d/app uriverse3d/next.config.ts uriverse3d/tailwind.config.ts uriverse3d/postcss.config.mjs uriverse3d/eslint.config.mjs
git commit -m "feat(uriverse3d): scaffold Next.js project"
```

---

## Task 2: Schema do Supabase (migração SQL)

**Files:**
- Create: `uriverse3d/supabase/migrations/0001_init.sql`
- Create: `uriverse3d/lib/types.ts`

- [ ] **Step 1: Escrever a migração**

Create `uriverse3d/supabase/migrations/0001_init.sql`:
```sql
create extension if not exists "pgcrypto";

create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null default '',
  category text not null,
  base_price_cents integer not null check (base_price_cents >= 0),
  weight_grams integer not null check (weight_grams > 0),
  length_cm numeric not null check (length_cm > 0),
  width_cm numeric not null check (width_cm > 0),
  height_cm numeric not null check (height_cm > 0),
  production_days integer not null default 5 check (production_days > 0),
  variations jsonb not null default '[]',
  photos jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'active')),
  created_at timestamptz not null default now()
);

create table customer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  cpf text,
  phone text,
  consent_given_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id),
  customer_email text not null,
  items jsonb not null,
  shipping_address jsonb not null,
  shipping_service text,
  shipping_price_cents integer,
  total_cents integer not null check (total_cents >= 0),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'refunded')),
  production_status text not null default 'queued' check (production_status in ('queued', 'in_production', 'ready', 'shipped', 'delivered')),
  tracking_code text,
  order_type text not null default 'standard' check (order_type in ('standard', 'custom')),
  mp_preference_id text,
  mp_payment_id text,
  created_at timestamptz not null default now()
);

create table custom_quote_requests (
  id uuid primary key default gen_random_uuid(),
  customer_email text not null,
  customer_name text not null,
  description text not null,
  reference_photo_url text,
  channel text not null default 'site' check (channel in ('site', 'whatsapp')),
  status text not null default 'pending' check (status in ('pending', 'quoted', 'accepted', 'declined')),
  quoted_price_cents integer,
  order_id uuid references orders(id),
  created_at timestamptz not null default now()
);

create table site_settings (
  id boolean primary key default true check (id),
  custom_orders_enabled boolean not null default false,
  alert_emails text[] not null default '{}'
);
insert into site_settings (id) values (true);

alter table products enable row level security;
alter table customer_profiles enable row level security;
alter table orders enable row level security;
alter table custom_quote_requests enable row level security;
alter table site_settings enable row level security;

create policy "public reads active products" on products
  for select using (status = 'active');

create policy "customers read own profile" on customer_profiles
  for select using (auth.uid() = id);
create policy "customers update own profile" on customer_profiles
  for update using (auth.uid() = id);

create policy "customers read own orders" on orders
  for select using (auth.uid() = customer_id);

create policy "anyone reads site settings" on site_settings
  for select using (true);
```

- [ ] **Step 2: Aplicar a migração no Supabase**

No painel do Supabase (SQL Editor), colar e rodar o conteúdo de `0001_init.sql` contra o projeto criado no Task 0. Confirmar as 5 tabelas aparecem em Table Editor.

- [ ] **Step 3: Criar os tipos TypeScript compartilhados**

Create `uriverse3d/lib/types.ts`:
```typescript
export type ProductVariation = {
  name: string
  options: string[]
}

export type Product = {
  id: string
  slug: string
  name: string
  description: string
  category: string
  base_price_cents: number
  weight_grams: number
  length_cm: number
  width_cm: number
  height_cm: number
  production_days: number
  variations: ProductVariation[]
  photos: string[]
  status: 'draft' | 'active'
}

export type CartItem = {
  productId: string
  slug: string
  name: string
  unitPriceCents: number
  quantity: number
  selectedVariations: Record<string, string>
}

export type ShippingAddress = {
  recipientName: string
  cep: string
  street: string
  number: string
  complement?: string
  neighborhood: string
  city: string
  state: string
}

export type FreightOption = {
  service: string
  carrier: string
  priceCents: number
  deliveryDays: number
}

export type Order = {
  id: string
  customer_email: string
  items: CartItem[]
  shipping_address: ShippingAddress
  shipping_service: string | null
  shipping_price_cents: number | null
  total_cents: number
  payment_status: 'pending' | 'paid' | 'refunded'
  production_status: 'queued' | 'in_production' | 'ready' | 'shipped' | 'delivered'
  tracking_code: string | null
  order_type: 'standard' | 'custom'
}
```

- [ ] **Step 4: Commit**

```bash
cd F:/RichClub
git add uriverse3d/supabase/migrations/0001_init.sql uriverse3d/lib/types.ts
git commit -m "feat(uriverse3d): add database schema and shared types"
```

---

## Task 3: Cliente Supabase + seed de produtos

**Files:**
- Create: `uriverse3d/lib/supabase/server.ts`
- Create: `uriverse3d/lib/supabase/client.ts`
- Create: `uriverse3d/lib/supabase/admin.ts`
- Create: `uriverse3d/scripts/seed.ts`
- Test: `uriverse3d/lib/products.test.ts`
- Create: `uriverse3d/lib/products.ts`

- [ ] **Step 1: Clientes Supabase (server, browser, admin)**

Create `uriverse3d/lib/supabase/client.ts`:
```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

Create `uriverse3d/lib/supabase/server.ts`:
```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )
}
```

Create `uriverse3d/lib/supabase/admin.ts` (service role — só usado em API routes de servidor, nunca no client):
```typescript
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
```

- [ ] **Step 2: Escrever o teste da camada de dados de produtos**

Create `uriverse3d/lib/products.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { mapRowToProduct } from './products'

describe('mapRowToProduct', () => {
  it('converts a raw Supabase row into a typed Product', () => {
    const row = {
      id: '1',
      slug: 'chibi-jimin',
      name: 'Chibi Jimin',
      description: 'Miniatura 3D',
      category: 'bts',
      base_price_cents: 8900,
      weight_grams: 120,
      length_cm: 8,
      width_cm: 6,
      height_cm: 10,
      production_days: 5,
      variations: [{ name: 'Cor', options: ['Rosa', 'Roxo'] }],
      photos: ['https://example.com/foto.jpg'],
      status: 'active',
    }

    const product = mapRowToProduct(row)

    expect(product.slug).toBe('chibi-jimin')
    expect(product.base_price_cents).toBe(8900)
    expect(product.variations[0].options).toEqual(['Rosa', 'Roxo'])
  })
})
```

- [ ] **Step 3: Rodar e confirmar falha**

Run: `npm test -- products.test.ts`
Expected: FAIL — `mapRowToProduct` não existe em `./products`.

- [ ] **Step 4: Implementar a camada de dados**

Create `uriverse3d/lib/products.ts`:
```typescript
import { createClient } from '@/lib/supabase/server'
import type { Product } from '@/lib/types'

export function mapRowToProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as string,
    base_price_cents: row.base_price_cents as number,
    weight_grams: row.weight_grams as number,
    length_cm: row.length_cm as number,
    width_cm: row.width_cm as number,
    height_cm: row.height_cm as number,
    production_days: row.production_days as number,
    variations: row.variations as Product['variations'],
    photos: row.photos as string[],
    status: row.status as Product['status'],
  }
}

export async function listActiveProducts(): Promise<Product[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to list products: ${error.message}`)
  return (data ?? []).map(mapRowToProduct)
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new Error(`Failed to load product: ${error.message}`)
  return data ? mapRowToProduct(data) : null
}
```

- [ ] **Step 5: Rodar e confirmar sucesso**

Run: `npm test -- products.test.ts`
Expected: PASS

- [ ] **Step 6: Script de seed (substitui UI de admin, que é sub-projeto futuro)**

Create `uriverse3d/scripts/seed.ts`:
```typescript
import { createAdminClient } from '../lib/supabase/admin'

const products = [
  {
    slug: 'chibi-jimin',
    name: 'Chibi Jimin',
    description: 'Miniatura 3D inspirada em Jimin (BTS), pintada à mão.',
    category: 'bts',
    base_price_cents: 8900,
    weight_grams: 120,
    length_cm: 8,
    width_cm: 6,
    height_cm: 10,
    production_days: 5,
    variations: [{ name: 'Cor da base', options: ['Rosa', 'Roxo', 'Preto'] }],
    photos: [],
    status: 'active',
  },
  {
    slug: 'porta-photocard-dorama',
    name: 'Porta Photocard Dorama',
    description: 'Suporte 3D pra photocard, tema K-drama.',
    category: 'dorama',
    base_price_cents: 4500,
    weight_grams: 60,
    length_cm: 10,
    width_cm: 7,
    height_cm: 1,
    production_days: 5,
    variations: [],
    photos: [],
    status: 'active',
  },
]

async function main() {
  const supabase = createAdminClient()
  const { error } = await supabase.from('products').upsert(products, { onConflict: 'slug' })
  if (error) throw error
  console.log(`Seeded ${products.length} products.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Add to `uriverse3d/package.json` scripts: `"seed": "tsx scripts/seed.ts"` (run `npm install -D tsx` first).

- [ ] **Step 7: Rodar o seed contra o Supabase real**

Run:
```bash
npm install -D tsx
npm run seed
```
Expected: `Seeded 2 products.`

- [ ] **Step 8: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib uriverse3d/scripts uriverse3d/package.json uriverse3d/package-lock.json
git commit -m "feat(uriverse3d): add Supabase clients, product data layer, seed script"
```

---

## Task 4: Catálogo e página de produto

**Files:**
- Create: `uriverse3d/app/page.tsx`
- Create: `uriverse3d/components/ProductCard.tsx`
- Create: `uriverse3d/app/produto/[slug]/page.tsx`
- Test: `uriverse3d/components/ProductCard.test.tsx`

- [ ] **Step 1: Teste do card de produto**

Create `uriverse3d/components/ProductCard.test.tsx`:
```typescript
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ProductCard } from './ProductCard'
import type { Product } from '@/lib/types'

const product: Product = {
  id: '1',
  slug: 'chibi-jimin',
  name: 'Chibi Jimin',
  description: 'Miniatura 3D',
  category: 'bts',
  base_price_cents: 8900,
  weight_grams: 120,
  length_cm: 8,
  width_cm: 6,
  height_cm: 10,
  production_days: 5,
  variations: [],
  photos: [],
  status: 'active',
}

describe('ProductCard', () => {
  it('shows name, formatted price and production time', () => {
    render(<ProductCard product={product} />)
    expect(screen.getByText('Chibi Jimin')).toBeInTheDocument()
    expect(screen.getByText('R$ 89,00')).toBeInTheDocument()
    expect(screen.getByText(/5 dias úteis/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- ProductCard.test.tsx`
Expected: FAIL — módulo `./ProductCard` não existe.

- [ ] **Step 3: Implementar o componente**

Create `uriverse3d/components/ProductCard.tsx`:
```typescript
import Link from 'next/link'
import type { Product } from '@/lib/types'

function formatPrice(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link href={`/produto/${product.slug}`} className="block rounded-lg border p-4 hover:shadow-md">
      <div className="aspect-square bg-gray-100 rounded-md mb-3" />
      <h3 className="font-medium">{product.name}</h3>
      <p className="text-lg font-semibold">{formatPrice(product.base_price_cents)}</p>
      <p className="text-sm text-gray-500">Pronto em {product.production_days} dias úteis</p>
    </Link>
  )
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- ProductCard.test.tsx`
Expected: PASS

- [ ] **Step 5: Página do catálogo**

Create `uriverse3d/app/page.tsx`:
```typescript
import { listActiveProducts } from '@/lib/products'
import { ProductCard } from '@/components/ProductCard'

export default async function CatalogPage() {
  const products = await listActiveProducts()

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Uriverse3D</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  )
}
```

- [ ] **Step 6: Página de produto**

Create `uriverse3d/app/produto/[slug]/page.tsx`:
```typescript
import { notFound } from 'next/navigation'
import { getProductBySlug } from '@/lib/products'

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const product = await getProductBySlug(slug)
  if (!product) notFound()

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold">{product.name}</h1>
      <p className="text-lg font-semibold mt-2">
        {(product.base_price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
      </p>
      <p className="text-sm text-gray-500">Pronto em {product.production_days} dias úteis</p>
      <p className="mt-4">{product.description}</p>
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
cd F:/RichClub
git add uriverse3d/app uriverse3d/components
git commit -m "feat(uriverse3d): add product catalog and product detail page"
```

---

## Task 5: Carrinho (Zustand)

**Files:**
- Create: `uriverse3d/lib/cart-store.ts`
- Test: `uriverse3d/lib/cart-store.test.ts`

- [ ] **Step 1: Teste da store**

Create `uriverse3d/lib/cart-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useCartStore } from './cart-store'

const item = {
  productId: '1',
  slug: 'chibi-jimin',
  name: 'Chibi Jimin',
  unitPriceCents: 8900,
  quantity: 1,
  selectedVariations: { Cor: 'Rosa' },
}

describe('useCartStore', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [] })
  })

  it('adds an item to an empty cart', () => {
    useCartStore.getState().addItem(item)
    expect(useCartStore.getState().items).toHaveLength(1)
  })

  it('increments quantity when the same variation is added again', () => {
    useCartStore.getState().addItem(item)
    useCartStore.getState().addItem(item)
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0].quantity).toBe(2)
  })

  it('computes the total in cents', () => {
    useCartStore.getState().addItem(item)
    useCartStore.getState().addItem({ ...item, quantity: 2 })
    expect(useCartStore.getState().totalCents()).toBe(8900 * 3)
  })

  it('removes an item by productId and variations', () => {
    useCartStore.getState().addItem(item)
    useCartStore.getState().removeItem('1', { Cor: 'Rosa' })
    expect(useCartStore.getState().items).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- cart-store.test.ts`
Expected: FAIL — `./cart-store` não existe.

- [ ] **Step 3: Implementar a store**

Create `uriverse3d/lib/cart-store.ts`:
```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CartItem } from '@/lib/types'

function sameVariations(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type CartState = {
  items: CartItem[]
  addItem: (item: CartItem) => void
  removeItem: (productId: string, variations: Record<string, string>) => void
  clear: () => void
  totalCents: () => number
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      addItem: (item) =>
        set((state) => {
          const existing = state.items.find(
            (i) => i.productId === item.productId && sameVariations(i.selectedVariations, item.selectedVariations)
          )
          if (existing) {
            return {
              items: state.items.map((i) =>
                i === existing ? { ...i, quantity: i.quantity + item.quantity } : i
              ),
            }
          }
          return { items: [...state.items, item] }
        }),
      removeItem: (productId, variations) =>
        set((state) => ({
          items: state.items.filter(
            (i) => !(i.productId === productId && sameVariations(i.selectedVariations, variations))
          ),
        })),
      clear: () => set({ items: [] }),
      totalCents: () => get().items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0),
    }),
    { name: 'uriverse3d-cart' }
  )
)
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- cart-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/cart-store.ts uriverse3d/lib/cart-store.test.ts
git commit -m "feat(uriverse3d): add cart store with persistence"
```

---

## Task 6: Cálculo de frete (Melhor Envio)

**Files:**
- Create: `uriverse3d/lib/melhorenvio.ts`
- Create: `uriverse3d/app/api/freight/route.ts`
- Test: `uriverse3d/lib/melhorenvio.test.ts`

- [ ] **Step 1: Teste do client de frete (com fetch mockado)**

Create `uriverse3d/lib/melhorenvio.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateFreight } from './melhorenvio'

describe('calculateFreight', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 1,
            name: 'PAC',
            company: { name: 'Correios' },
            price: '24.90',
            delivery_time: 8,
            error: null,
          },
          {
            id: 2,
            name: 'SEDEX',
            company: { name: 'Correios' },
            price: '39.50',
            delivery_time: 3,
            error: null,
          },
        ],
      })
    )
  })

  it('maps Melhor Envio quotes into FreightOption list, skipping errors', async () => {
    const options = await calculateFreight({
      destinationCep: '01310100',
      weightGrams: 120,
      lengthCm: 8,
      widthCm: 6,
      heightCm: 10,
    })

    expect(options).toEqual([
      { service: 'PAC', carrier: 'Correios', priceCents: 2490, deliveryDays: 8 },
      { service: 'SEDEX', carrier: 'Correios', priceCents: 3950, deliveryDays: 3 },
    ])
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- melhorenvio.test.ts`
Expected: FAIL — `./melhorenvio` não existe.

- [ ] **Step 3: Implementar o client**

Create `uriverse3d/lib/melhorenvio.ts`:
```typescript
import type { FreightOption } from '@/lib/types'

type FreightInput = {
  destinationCep: string
  weightGrams: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

type MelhorEnvioQuote = {
  id: number
  name: string
  company: { name: string }
  price: string
  delivery_time: number
  error: string | null
}

export async function calculateFreight(input: FreightInput): Promise<FreightOption[]> {
  const response = await fetch(`${process.env.MELHORENVIO_BASE_URL}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.MELHORENVIO_TOKEN}`,
    },
    body: JSON.stringify({
      from: { postal_code: process.env.ORIGIN_CEP },
      to: { postal_code: input.destinationCep.replace(/\D/g, '') },
      package: {
        weight: input.weightGrams / 1000,
        width: input.widthCm,
        height: input.heightCm,
        length: input.lengthCm,
      },
    }),
  })

  if (!response.ok) throw new Error(`Melhor Envio request failed: ${response.status}`)

  const quotes: MelhorEnvioQuote[] = await response.json()

  return quotes
    .filter((quote) => !quote.error)
    .map((quote) => ({
      service: quote.name,
      carrier: quote.company.name,
      priceCents: Math.round(parseFloat(quote.price) * 100),
      deliveryDays: quote.delivery_time,
    }))
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- melhorenvio.test.ts`
Expected: PASS

- [ ] **Step 5: Rota de API pra cotação**

Create `uriverse3d/app/api/freight/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { calculateFreight } from '@/lib/melhorenvio'

const bodySchema = z.object({
  destinationCep: z.string().min(8),
  weightGrams: z.number().positive(),
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
})

export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json())
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  try {
    const options = await calculateFreight(body.data)
    return NextResponse.json({ options })
  } catch {
    return NextResponse.json({ error: 'Freight calculation failed' }, { status: 502 })
  }
}
```

- [ ] **Step 6: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/melhorenvio.ts uriverse3d/lib/melhorenvio.test.ts uriverse3d/app/api/freight
git commit -m "feat(uriverse3d): add Melhor Envio freight calculation"
```

---

## Task 7: Criar pedido (Order) no checkout

**Files:**
- Create: `uriverse3d/lib/orders.ts`
- Create: `uriverse3d/app/api/orders/route.ts`
- Test: `uriverse3d/lib/orders.test.ts`

- [ ] **Step 1: Teste da criação de pedido**

Create `uriverse3d/lib/orders.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { computeOrderTotal } from './orders'
import type { CartItem } from '@/lib/types'

describe('computeOrderTotal', () => {
  it('sums item totals plus shipping', () => {
    const items: CartItem[] = [
      { productId: '1', slug: 'a', name: 'A', unitPriceCents: 1000, quantity: 2, selectedVariations: {} },
      { productId: '2', slug: 'b', name: 'B', unitPriceCents: 500, quantity: 1, selectedVariations: {} },
    ]
    expect(computeOrderTotal(items, 990)).toBe(1000 * 2 + 500 + 990)
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- orders.test.ts`
Expected: FAIL — `./orders` não existe.

- [ ] **Step 3: Implementar `computeOrderTotal` e `createOrder`**

Create `uriverse3d/lib/orders.ts`:
```typescript
import { createAdminClient } from '@/lib/supabase/admin'
import type { CartItem, ShippingAddress } from '@/lib/types'

export function computeOrderTotal(items: CartItem[], shippingPriceCents: number): number {
  const itemsTotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0)
  return itemsTotal + shippingPriceCents
}

type CreateOrderInput = {
  customerEmail: string
  items: CartItem[]
  shippingAddress: ShippingAddress
  shippingService: string
  shippingPriceCents: number
}

export async function createOrder(input: CreateOrderInput): Promise<{ id: string; totalCents: number }> {
  const supabase = createAdminClient()
  const totalCents = computeOrderTotal(input.items, input.shippingPriceCents)

  const { data, error } = await supabase
    .from('orders')
    .insert({
      customer_email: input.customerEmail,
      items: input.items,
      shipping_address: input.shippingAddress,
      shipping_service: input.shippingService,
      shipping_price_cents: input.shippingPriceCents,
      total_cents: totalCents,
      payment_status: 'pending',
      production_status: 'queued',
      order_type: 'standard',
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create order: ${error.message}`)
  return { id: data.id, totalCents }
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- orders.test.ts`
Expected: PASS

- [ ] **Step 5: Rota de API `/api/orders`**

Create `uriverse3d/app/api/orders/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createOrder } from '@/lib/orders'

const cartItemSchema = z.object({
  productId: z.string(),
  slug: z.string(),
  name: z.string(),
  unitPriceCents: z.number().positive(),
  quantity: z.number().int().positive(),
  selectedVariations: z.record(z.string()),
})

const bodySchema = z.object({
  customerEmail: z.string().email(),
  items: z.array(cartItemSchema).min(1),
  shippingAddress: z.object({
    recipientName: z.string().min(1),
    cep: z.string().min(8),
    street: z.string().min(1),
    number: z.string().min(1),
    complement: z.string().optional(),
    neighborhood: z.string().min(1),
    city: z.string().min(1),
    state: z.string().length(2),
  }),
  shippingService: z.string(),
  shippingPriceCents: z.number().nonnegative(),
})

export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json())
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const order = await createOrder(body.data)
  return NextResponse.json(order, { status: 201 })
}
```

- [ ] **Step 6: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/orders.ts uriverse3d/lib/orders.test.ts uriverse3d/app/api/orders
git commit -m "feat(uriverse3d): create order records from checkout"
```

---

## Task 8: Pagamento embutido (Mercado Pago Payment Brick) + webhook

**Files:**
- Create: `uriverse3d/lib/mercadopago.ts`
- Create: `uriverse3d/app/api/payments/route.ts`
- Create: `uriverse3d/app/api/webhooks/mercadopago/route.ts`
- Test: `uriverse3d/lib/mercadopago.test.ts`

- [ ] **Step 1: Teste do mapeamento de status de pagamento**

Create `uriverse3d/lib/mercadopago.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { mapMpStatusToPaymentStatus } from './mercadopago'

describe('mapMpStatusToPaymentStatus', () => {
  it('maps approved to paid', () => {
    expect(mapMpStatusToPaymentStatus('approved')).toBe('paid')
  })

  it('maps refunded and charged_back to refunded', () => {
    expect(mapMpStatusToPaymentStatus('refunded')).toBe('refunded')
    expect(mapMpStatusToPaymentStatus('charged_back')).toBe('refunded')
  })

  it('maps everything else to pending', () => {
    expect(mapMpStatusToPaymentStatus('in_process')).toBe('pending')
    expect(mapMpStatusToPaymentStatus('rejected')).toBe('pending')
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- mercadopago.test.ts`
Expected: FAIL — `./mercadopago` não existe.

- [ ] **Step 3: Implementar o client e o mapeamento**

Create `uriverse3d/lib/mercadopago.ts`:
```typescript
import { MercadoPagoConfig, Payment } from 'mercadopago'

export function getMpClient() {
  return new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN! })
}

export function getPaymentClient() {
  return new Payment(getMpClient())
}

export type PaymentStatus = 'pending' | 'paid' | 'refunded'

export function mapMpStatusToPaymentStatus(mpStatus: string): PaymentStatus {
  if (mpStatus === 'approved') return 'paid'
  if (mpStatus === 'refunded' || mpStatus === 'charged_back') return 'refunded'
  return 'pending'
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- mercadopago.test.ts`
Expected: PASS

- [ ] **Step 5: Rota que envia o pagamento pro Mercado Pago**

Create `uriverse3d/app/api/payments/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getPaymentClient } from '@/lib/mercadopago'
import { createAdminClient } from '@/lib/supabase/admin'

const bodySchema = z.object({
  orderId: z.string().uuid(),
  transactionAmount: z.number().positive(),
  token: z.string().optional(),
  paymentMethodId: z.string(),
  installments: z.number().int().positive().default(1),
  payer: z.object({
    email: z.string().email(),
    identification: z.object({ type: z.string(), number: z.string() }).optional(),
  }),
})

export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json())
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { orderId, transactionAmount, token, paymentMethodId, installments, payer } = body.data

  const payment = await getPaymentClient().create({
    body: {
      transaction_amount: transactionAmount,
      token,
      installments,
      payment_method_id: paymentMethodId,
      payer,
      external_reference: orderId,
      notification_url: `${process.env.SITE_URL}/api/webhooks/mercadopago`,
    },
  })

  const supabase = createAdminClient()
  await supabase.from('orders').update({ mp_payment_id: String(payment.id) }).eq('id', orderId)

  return NextResponse.json({ status: payment.status, id: payment.id })
}
```

- [ ] **Step 6: Webhook que confirma o pagamento (fonte da verdade)**

Create `uriverse3d/app/api/webhooks/mercadopago/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { getPaymentClient, mapMpStatusToPaymentStatus } from '@/lib/mercadopago'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  const payload = await request.json()
  const paymentId = payload?.data?.id
  if (!paymentId) return NextResponse.json({ ok: true })

  const payment = await getPaymentClient().get({ id: paymentId })
  const orderId = payment.external_reference
  if (!orderId) return NextResponse.json({ ok: true })

  const paymentStatus = mapMpStatusToPaymentStatus(payment.status ?? '')
  const supabase = createAdminClient()

  const update: Record<string, unknown> = { payment_status: paymentStatus, mp_payment_id: String(payment.id) }
  if (paymentStatus === 'paid') update.production_status = 'queued'

  await supabase.from('orders').update(update).eq('id', orderId)

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 7: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/mercadopago.ts uriverse3d/lib/mercadopago.test.ts uriverse3d/app/api/payments uriverse3d/app/api/webhooks
git commit -m "feat(uriverse3d): integrate Mercado Pago payment and confirmation webhook"
```

---

## Task 9: Página de checkout (frontend juntando frete + Payment Brick)

**Files:**
- Create: `uriverse3d/app/checkout/page.tsx`
- Create: `uriverse3d/components/CheckoutForm.tsx`
- Create: `uriverse3d/app/pedido/confirmado/[id]/page.tsx`

- [ ] **Step 1: Formulário de checkout (endereço → frete → pagamento)**

Create `uriverse3d/components/CheckoutForm.tsx`:
```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { initMercadoPago, Payment } from '@mercadopago/sdk-react'
import { useCartStore } from '@/lib/cart-store'
import type { FreightOption, ShippingAddress } from '@/lib/types'

initMercadoPago(process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY!, { locale: 'pt-BR' })

export function CheckoutForm() {
  const router = useRouter()
  const items = useCartStore((s) => s.items)
  const totalCents = useCartStore((s) => s.totalCents())
  const clearCart = useCartStore((s) => s.clear)

  const [email, setEmail] = useState('')
  const [address, setAddress] = useState<ShippingAddress>({
    recipientName: '',
    cep: '',
    street: '',
    number: '',
    neighborhood: '',
    city: '',
    state: '',
  })
  const [freightOptions, setFreightOptions] = useState<FreightOption[]>([])
  const [selectedFreight, setSelectedFreight] = useState<FreightOption | null>(null)
  const [orderId, setOrderId] = useState<string | null>(null)

  async function handleCalculateFreight() {
    const firstItem = items[0]
    const response = await fetch('/api/freight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destinationCep: address.cep,
        weightGrams: 200,
        lengthCm: 15,
        widthCm: 12,
        heightCm: 10,
      }),
    })
    if (!response.ok) return
    const data = await response.json()
    setFreightOptions(data.options)
  }

  async function handleCreateOrder() {
    if (!selectedFreight) return
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerEmail: email,
        items,
        shippingAddress: address,
        shippingService: selectedFreight.service,
        shippingPriceCents: selectedFreight.priceCents,
      }),
    })
    const order = await response.json()
    setOrderId(order.id)
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <section>
        <h2 className="font-semibold mb-2">Endereço de entrega</h2>
        <input
          className="border rounded px-3 py-2 w-full mb-2"
          placeholder="CEP"
          value={address.cep}
          onChange={(e) => setAddress({ ...address, cep: e.target.value })}
        />
        <button className="border rounded px-3 py-2" onClick={handleCalculateFreight} type="button">
          Calcular frete
        </button>
      </section>

      {freightOptions.length > 0 && !orderId && (
        <section>
          <h2 className="font-semibold mb-2">Escolha o frete</h2>
          {freightOptions.map((option) => (
            <label key={option.service} className="block">
              <input
                type="radio"
                name="freight"
                onChange={() => setSelectedFreight(option)}
              />{' '}
              {option.carrier} {option.service} — R$ {(option.priceCents / 100).toFixed(2)} ({option.deliveryDays} dias)
            </label>
          ))}
          <input
            className="border rounded px-3 py-2 w-full mt-2"
            placeholder="Seu e-mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="border rounded px-3 py-2 mt-2" onClick={handleCreateOrder} type="button">
            Ir para pagamento
          </button>
        </section>
      )}

      {orderId && selectedFreight && (
        <section>
          <h2 className="font-semibold mb-2">Pagamento</h2>
          <Payment
            initialization={{ amount: totalCents / 100, payer: { email } }}
            customization={{ paymentMethods: { bankTransfer: 'all', creditCard: 'all' } }}
            onSubmit={async ({ formData }) => {
              const response = await fetch('/api/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  orderId,
                  transactionAmount: totalCents / 100,
                  token: formData.token,
                  paymentMethodId: formData.payment_method_id,
                  installments: formData.installments ?? 1,
                  payer: { email },
                }),
              })
              if (response.ok) {
                clearCart()
                router.push(`/pedido/confirmado/${orderId}`)
              }
            }}
          />
        </section>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Página de checkout**

Create `uriverse3d/app/checkout/page.tsx`:
```typescript
import { CheckoutForm } from '@/components/CheckoutForm'

export default function CheckoutPage() {
  return (
    <main className="px-4 py-8">
      <h1 className="text-2xl font-bold text-center mb-6">Finalizar pedido</h1>
      <CheckoutForm />
    </main>
  )
}
```

- [ ] **Step 3: Página de confirmação**

Create `uriverse3d/app/pedido/confirmado/[id]/page.tsx`:
```typescript
export default async function OrderConfirmedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <main className="max-w-xl mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-bold">Pedido recebido!</h1>
      <p className="mt-2 text-gray-600">
        Assim que o pagamento for confirmado você recebe um e-mail. Número do pedido: {id}
      </p>
    </main>
  )
}
```

- [ ] **Step 4: Verificação manual no navegador**

Rodar `npm run dev`, abrir o catálogo, adicionar produto ao carrinho, ir pro checkout, calcular frete (CEP de teste `01310100`), selecionar frete, informar e-mail, criar pedido, confirmar que o Payment Brick renderiza. (Pagamento de verdade só é testável com credenciais sandbox reais do Task 0 — se ainda não tiver, ao menos confirmar que a UI monta sem erro de console.)

- [ ] **Step 5: Commit**

```bash
cd F:/RichClub
git add uriverse3d/app/checkout uriverse3d/app/pedido uriverse3d/components/CheckoutForm.tsx
git commit -m "feat(uriverse3d): add checkout page with freight selection and Payment Brick"
```

---

## Task 10: E-mails transacionais (confirmação e rastreio)

**Files:**
- Create: `uriverse3d/lib/email.ts`
- Modify: `uriverse3d/app/api/webhooks/mercadopago/route.ts`
- Create: `uriverse3d/app/api/orders/[id]/tracking/route.ts`
- Test: `uriverse3d/lib/email.test.ts`

- [ ] **Step 1: Teste do conteúdo dos e-mails**

Create `uriverse3d/lib/email.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildOrderConfirmedEmail, buildShippedEmail } from './email'

describe('buildOrderConfirmedEmail', () => {
  it('includes the order id and total', () => {
    const email = buildOrderConfirmedEmail({ orderId: 'abc123', totalCents: 8900 })
    expect(email.subject).toContain('Pedido confirmado')
    expect(email.html).toContain('abc123')
    expect(email.html).toContain('R$ 89,00')
  })
})

describe('buildShippedEmail', () => {
  it('includes the tracking code', () => {
    const email = buildShippedEmail({ orderId: 'abc123', trackingCode: 'BR123456789BR' })
    expect(email.subject).toContain('enviado')
    expect(email.html).toContain('BR123456789BR')
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- email.test.ts`
Expected: FAIL — `./email` não existe.

- [ ] **Step 3: Implementar templates e envio**

Create `uriverse3d/lib/email.ts`:
```typescript
import { Resend } from 'resend'

function formatPrice(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function buildOrderConfirmedEmail(input: { orderId: string; totalCents: number }) {
  return {
    subject: 'Pedido confirmado — Uriverse3D',
    html: `<p>Seu pedido <strong>${input.orderId}</strong> foi confirmado. Total: ${formatPrice(input.totalCents)}.</p>
           <p>Seu produto entra na fila de produção agora. Assim que for enviado, você recebe o código de rastreio por aqui.</p>`,
  }
}

export function buildShippedEmail(input: { orderId: string; trackingCode: string }) {
  return {
    subject: 'Seu pedido foi enviado — Uriverse3D',
    html: `<p>Seu pedido <strong>${input.orderId}</strong> foi enviado.</p>
           <p>Código de rastreio: <strong>${input.trackingCode}</strong></p>`,
  }
}

export async function sendEmail(to: string, message: { subject: string; html: string }) {
  const resend = new Resend(process.env.RESEND_API_KEY)
  await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to,
    subject: message.subject,
    html: message.html,
  })
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- email.test.ts`
Expected: PASS

- [ ] **Step 5: Disparar e-mail de confirmação no webhook**

Modify `uriverse3d/app/api/webhooks/mercadopago/route.ts` — adicionar após o `update` do pedido pago:
```typescript
import { buildOrderConfirmedEmail, sendEmail } from '@/lib/email'

// ... dentro do POST, depois de `await supabase.from('orders').update(update).eq('id', orderId)`:
if (paymentStatus === 'paid') {
  const { data: order } = await supabase
    .from('orders')
    .select('customer_email, total_cents')
    .eq('id', orderId)
    .single()
  if (order) {
    await sendEmail(order.customer_email, buildOrderConfirmedEmail({ orderId, totalCents: order.total_cents }))
  }
}
```

- [ ] **Step 6: Rota interna pra registrar rastreio e disparar o e-mail (substitui UI de admin por enquanto)**

Create `uriverse3d/app/api/orders/[id]/tracking/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildShippedEmail, sendEmail } from '@/lib/email'

const bodySchema = z.object({ trackingCode: z.string().min(5) })

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = bodySchema.safeParse(await request.json())
  if (!body.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })

  const supabase = createAdminClient()
  const { data: order, error } = await supabase
    .from('orders')
    .update({ production_status: 'shipped', tracking_code: body.data.trackingCode })
    .eq('id', id)
    .select('customer_email')
    .single()

  if (error || !order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  await sendEmail(order.customer_email, buildShippedEmail({ orderId: id, trackingCode: body.data.trackingCode }))

  return NextResponse.json({ ok: true })
}
```

Nota: essa rota ainda não tem autenticação de admin — o sub-projeto Admin vai colocar login por trás dela. Por ora, não expor publicamente (não linkar no frontend).

- [ ] **Step 7: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/email.ts uriverse3d/lib/email.test.ts uriverse3d/app/api/webhooks/mercadopago/route.ts uriverse3d/app/api/orders
git commit -m "feat(uriverse3d): send order-confirmed and shipped-with-tracking emails"
```

---

## Task 11: Encomenda personalizada (toggle + formulário) e botão WhatsApp

**Files:**
- Create: `uriverse3d/lib/site-settings.ts`
- Create: `uriverse3d/app/api/quote-requests/route.ts`
- Create: `uriverse3d/app/encomenda/page.tsx`
- Create: `uriverse3d/components/QuoteRequestForm.tsx`
- Create: `uriverse3d/components/WhatsAppButton.tsx`
- Test: `uriverse3d/lib/site-settings.test.ts`

- [ ] **Step 1: Teste da leitura do toggle**

Create `uriverse3d/lib/site-settings.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        single: async () => ({ data: { custom_orders_enabled: true }, error: null }),
      }),
    }),
  })),
}))

import { areCustomOrdersEnabled } from './site-settings'

describe('areCustomOrdersEnabled', () => {
  it('returns the flag from site_settings', async () => {
    expect(await areCustomOrdersEnabled()).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- site-settings.test.ts`
Expected: FAIL — `./site-settings` não existe.

- [ ] **Step 3: Implementar**

Create `uriverse3d/lib/site-settings.ts`:
```typescript
import { createClient } from '@/lib/supabase/server'

export async function areCustomOrdersEnabled(): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('site_settings')
    .select('custom_orders_enabled')
    .single()

  if (error || !data) return false
  return data.custom_orders_enabled
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- site-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Rota de API pra criar o pedido de orçamento**

Create `uriverse3d/app/api/quote-requests/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { areCustomOrdersEnabled } from '@/lib/site-settings'

const bodySchema = z.object({
  customerName: z.string().min(1),
  customerEmail: z.string().email(),
  description: z.string().min(10),
  referencePhotoUrl: z.string().url().optional(),
})

export async function POST(request: Request) {
  if (!(await areCustomOrdersEnabled())) {
    return NextResponse.json({ error: 'Encomendas personalizadas estão fechadas no momento' }, { status: 403 })
  }

  const body = bodySchema.safeParse(await request.json())
  if (!body.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })

  const supabase = createAdminClient()
  const { error } = await supabase.from('custom_quote_requests').insert({
    customer_name: body.data.customerName,
    customer_email: body.data.customerEmail,
    description: body.data.description,
    reference_photo_url: body.data.referencePhotoUrl,
    channel: 'site',
  })

  if (error) return NextResponse.json({ error: 'Failed to save request' }, { status: 500 })
  return NextResponse.json({ ok: true }, { status: 201 })
}
```

- [ ] **Step 6: Formulário**

Create `uriverse3d/components/QuoteRequestForm.tsx`:
```typescript
'use client'

import { useState } from 'react'

export function QuoteRequestForm() {
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const response = await fetch('/api/quote-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: form.get('customerName'),
        customerEmail: form.get('customerEmail'),
        description: form.get('description'),
      }),
    })
    setStatus(response.ok ? 'sent' : 'error')
  }

  if (status === 'sent') return <p>Recebemos seu pedido! A Raquel te retorna por e-mail com o orçamento.</p>

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-xl">
      <input name="customerName" required placeholder="Seu nome" className="border rounded px-3 py-2 w-full" />
      <input name="customerEmail" required type="email" placeholder="Seu e-mail" className="border rounded px-3 py-2 w-full" />
      <textarea name="description" required minLength={10} placeholder="Descreva o que você quer" className="border rounded px-3 py-2 w-full" rows={4} />
      <button type="submit" className="border rounded px-4 py-2">Enviar pedido de orçamento</button>
      {status === 'error' && <p className="text-red-600">Não foi possível enviar. Tente de novo.</p>}
    </form>
  )
}
```

- [ ] **Step 7: Botão WhatsApp (sempre visível, sem toggle)**

Create `uriverse3d/components/WhatsAppButton.tsx`:
```typescript
export function WhatsAppButton() {
  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
  const message = encodeURIComponent('Oi! Quero fazer um pedido personalizado no Uriverse3D.')

  return (
    <a
      href={`https://wa.me/${number}?text=${message}`}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-4 right-4 bg-green-600 text-white rounded-full px-4 py-3 shadow-lg"
    >
      Falar no WhatsApp
    </a>
  )
}
```

- [ ] **Step 8: Página de encomenda (condicional ao toggle)**

Create `uriverse3d/app/encomenda/page.tsx`:
```typescript
import { areCustomOrdersEnabled } from '@/lib/site-settings'
import { QuoteRequestForm } from '@/components/QuoteRequestForm'

export default async function CustomOrderPage() {
  const enabled = await areCustomOrdersEnabled()

  return (
    <main className="max-w-xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">Encomenda personalizada</h1>
      {enabled ? (
        <QuoteRequestForm />
      ) : (
        <p>
          As encomendas personalizadas estão fechadas no momento. Fale com a gente pelo WhatsApp (botão no canto da tela)
          pra saber quando reabrem.
        </p>
      )}
    </main>
  )
}
```

- [ ] **Step 9: Adicionar o botão de WhatsApp no layout global**

Modify `uriverse3d/app/layout.tsx` — importar `WhatsAppButton` e renderizar dentro do `<body>`, após `{children}`.

- [ ] **Step 10: Commit**

```bash
cd F:/RichClub
git add uriverse3d/lib/site-settings.ts uriverse3d/lib/site-settings.test.ts uriverse3d/app/api/quote-requests uriverse3d/app/encomenda uriverse3d/components/QuoteRequestForm.tsx uriverse3d/components/WhatsAppButton.tsx uriverse3d/app/layout.tsx
git commit -m "feat(uriverse3d): add toggleable custom-order quote form and WhatsApp button"
```

---

## Task 12: LGPD — consentimento e base de exclusão

**Files:**
- Create: `uriverse3d/app/cadastro/page.tsx`
- Create: `uriverse3d/components/SignupForm.tsx`
- Test: `uriverse3d/components/SignupForm.test.tsx`

- [ ] **Step 1: Teste — formulário exige consentimento marcado**

Create `uriverse3d/components/SignupForm.test.tsx`:
```typescript
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { SignupForm } from './SignupForm'

describe('SignupForm', () => {
  it('disables submit until consent checkbox is checked', async () => {
    render(<SignupForm />)
    const submit = screen.getByRole('button', { name: /criar conta/i })
    expect(submit).toBeDisabled()

    await userEvent.click(screen.getByLabelText(/concordo com o tratamento/i))
    expect(submit).toBeEnabled()
  })
})
```

Run: `npm install -D @testing-library/user-event`

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npm test -- SignupForm.test.tsx`
Expected: FAIL — `./SignupForm` não existe.

- [ ] **Step 3: Implementar o formulário**

Create `uriverse3d/components/SignupForm.tsx`:
```typescript
'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export function SignupForm() {
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email'))
    const password = String(form.get('password'))
    const fullName = String(form.get('fullName'))

    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error || !data.user) {
      setStatus('error')
      return
    }

    await supabase.from('customer_profiles').insert({
      id: data.user.id,
      full_name: fullName,
      consent_given_at: new Date().toISOString(),
    })
    setStatus('done')
  }

  if (status === 'done') return <p>Conta criada! Confira seu e-mail pra confirmar o cadastro.</p>

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
      <input name="fullName" required placeholder="Nome completo" className="border rounded px-3 py-2 w-full" />
      <input name="email" required type="email" placeholder="E-mail" className="border rounded px-3 py-2 w-full" />
      <input name="password" required type="password" minLength={8} placeholder="Senha" className="border rounded px-3 py-2 w-full" />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        Eu concordo com o tratamento dos meus dados pessoais pra processar meu pedido, conforme a LGPD.
      </label>
      <button type="submit" disabled={!consent} className="border rounded px-4 py-2 disabled:opacity-50">
        Criar conta
      </button>
      {status === 'error' && <p className="text-red-600">Não foi possível criar a conta.</p>}
    </form>
  )
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npm test -- SignupForm.test.tsx`
Expected: PASS

- [ ] **Step 5: Página de cadastro**

Create `uriverse3d/app/cadastro/page.tsx`:
```typescript
import { SignupForm } from '@/components/SignupForm'

export default function SignupPage() {
  return (
    <main className="px-4 py-8">
      <h1 className="text-2xl font-bold mb-6 text-center">Criar conta</h1>
      <SignupForm />
    </main>
  )
}
```

- [ ] **Step 6: Commit**

```bash
cd F:/RichClub
git add uriverse3d/components/SignupForm.tsx uriverse3d/components/SignupForm.test.tsx uriverse3d/app/cadastro uriverse3d/package.json uriverse3d/package-lock.json
git commit -m "feat(uriverse3d): add signup form with LGPD consent capture"
```

Nota: senha já sai hasheada pelo Supabase Auth (nunca lidamos com texto puro). `deleted_at` em `customer_profiles` já existe no schema (Task 2) — o fluxo completo de solicitação de exclusão fica no sub-projeto Notificações/LGPD.

---

## Task 13: Verificação manual ponta a ponta + deploy prep

Isso fecha o sub-projeto. Sem código novo — é o gate de qualidade antes de considerar "fundação + loja" pronta.

- [ ] **Step 1: Rodar toda a suíte de testes**

Run: `npm test`
Expected: todos os testes de Tasks 3–12 passam.

- [ ] **Step 2: Fluxo manual completo no navegador (usar a skill `run` ou abrir manualmente)**

Com `npm run dev` no ar e credenciais reais (ou sandbox) de Task 0 preenchidas em `.env.local`:
1. Abrir catálogo, confirmar os 2 produtos do seed aparecem.
2. Abrir página de produto, confirmar preço/prazo.
3. Adicionar ao carrinho, ir pro checkout.
4. Calcular frete com CEP válido, confirmar opções retornam da Melhor Envio (sandbox).
5. Criar pedido, confirmar registro aparece na tabela `orders` do Supabase.
6. Testar pagamento com [cartão de teste do Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/additional-content/your-integrations/test/cards) — confirmar que o webhook local (usar `ngrok` ou similar pra expor `localhost:3000` durante o teste) atualiza `payment_status` pra `paid` e dispara e-mail (checar no painel do Resend, aba Logs).
7. Chamar manualmente `POST /api/orders/{id}/tracking` com um código fake, confirmar e-mail de rastreio chega.
8. Com `custom_orders_enabled = false` no Supabase, confirmar `/encomenda` mostra a mensagem de fechado; virar `true`, confirmar formulário aparece e envia.
9. Confirmar botão de WhatsApp aparece em todas as páginas e abre o link certo.

- [ ] **Step 3: Registrar quaisquer bugs encontrados como tasks extras neste plano antes de fechar**

Se algo falhar no passo 2, criar uma correção pontual (teste + fix + commit) antes de considerar o sub-projeto pronto — não seguir pro deploy com fluxo quebrado.

- [ ] **Step 4: Checklist de variáveis de ambiente na Vercel**

Antes do primeiro deploy real, confirmar que todas as vars de `.env.local.example` estão cadastradas em Vercel → Project Settings → Environment Variables (produção usa token de produção do Mercado Pago, não sandbox).

- [ ] **Step 5: Rodar o gate de deploy do projeto**

Antes de publicar em produção, seguir a skill `deploy-gate` (obrigatória neste workspace pra projetos com dado sensível/cliente pagante).
