# Nutri-Shop

Private, invite-only nutrition tracker and shopping-list app. Not e-commerce; no payments.

## Stack
Next.js 16 (App Router) · Supabase (Postgres + Auth, Row Level Security) · TypeScript · Tailwind 4 · Vercel.

## Local setup
1. Install Node 24 LTS and enable pnpm: `corepack enable && corepack prepare pnpm@11.9.0 --activate`
2. `pnpm install`
3. Copy env: `cp .env.example .env` and fill in values from your Supabase project (Settings → API). Set `NEXT_PUBLIC_SITE_URL` to your origin (e.g. `http://localhost:3000` locally).
4. Start Supabase locally (for tests): `supabase start`
5. `pnpm dev` → http://localhost:3000

## Scripts
- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` · `pnpm typecheck` · `pnpm test`

## Security
Secrets live only in `.env` (gitignored) and Vercel env settings — never in the repo. Auth email links are built from `NEXT_PUBLIC_SITE_URL` (a trusted constant), and Supabase's redirect allowlist must list only your real origins (no wildcards). See `SECURITY.md`.
