# Hosting — the cheapest viable stack

Goal: run this open, donation-supported project for **as close to $0 as possible**, with no legal
gotchas from the fact that it accepts donations.

## Recommendation: Cloudflare, not Vercel

The catch that decides it: **Vercel's free "Hobby" tier is restricted to non-commercial, personal use**
— and a donation button arguably crosses that line, putting you in a grey area / technical ToS
violation. **Cloudflare's free tier has no such restriction**, is more generous, and is genuinely the
cheapest path.

### The stack (effectively $0 for a long time)

| Layer | Use | Free-tier reality (2026) |
|-------|-----|--------------------------|
| **Knowledge base** (70+ static pages) | Cloudflare **Pages** (static) | Static assets served free/unlimited — the whole KB costs ~nothing |
| **App logic** (logging, the derive-metrics engine, autoregulation) | Cloudflare **Workers** | ~100k requests/day (~3M/mo); 10 ms CPU/req |
| **Database** | Cloudflare **D1** (SQLite) | 5 GB storage; 5M row-reads/day; 100k writes/day |
| **Progress photos / media** | Cloudflare **R2** | 10 GB free; **no egress fees** |
| **Cache / sessions** | Cloudflare **KV** | 1 GB; 100k reads/day |
| **Auth** | Better Auth (self-hosted, free) or a free-tier provider | $0 early |

**The key architectural insight:** the KB is *static content*, so ~90% of the app (all the education)
serves for free from Pages; only the genuinely dynamic parts (workout logs, personalization) touch
Workers + D1 — and those free limits won't bind until you have *thousands* of daily active users.

### Cost ladder

| Stage | Cost |
|-------|------|
| Launch on a free `*.pages.dev` subdomain | **$0** |
| Add a custom domain | **~$8–12/yr** (the only real early cost) |
| Exceed Workers 100k req/day (thousands of DAU) | **$5/mo** Workers Paid |
| Larger scale | Grows gently and predictably; D1/R2/Workers are cheap per unit |

So the honest funding story for the [donation page](donation-page.md) is: *early on this runs for about
the price of a domain name.*

## Framework choice

- **Cheapest + simplest:** serve the KB as static (Markdown → static HTML via Astro/Next static export
  on Pages), and build the dynamic app as **Workers + D1** (with Hono or Next-on-Workers via OpenNext).
- The `data/` layer (schemas, exercises, muscles, programs) and `tools/derive-metrics.mjs` are already
  framework-agnostic pure JS — they drop straight into a Worker.

## Why not the alternatives

- **Vercel Hobby + Supabase/Neon** — also free, familiar Next.js DX, but (1) Vercel Hobby is
  non-commercial-only (donation-button risk), and (2) Supabase's free DB **pauses after 7 days of
  inactivity** — bad for a low-traffic launch.
- **A traditional VPS** (e.g. a $5/mo droplet) — predictable but not free, and you manage the server.
  Cloudflare's free tier beats it until real scale.

## Sources

- [Vercel Hobby plan docs](https://vercel.com/docs/plans/hobby) · [Vercel free-tier limits 2026](https://deploywise.dev/blog/vercel-free-tier-limits-2026)
- [Supabase free-tier limits 2026](https://aiagencyplus.com/supabase-free-tier-limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [Workers & Pages pricing](https://www.cloudflare.com/plans/developer-platform/)
