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
- **MongoDB Atlas** (evaluated 2026-10, for KB search and a cross-user analytics copy) — moves
  none of [the four goals](improvement-loop.md), and costs real things. Workers can't reuse a
  database connection across requests and Hyperdrive doesn't support MongoDB, so every API call
  would pay a fresh TCP + TLS + auth handshake (~300 ms within a continent, ~2 s across an ocean,
  measured); the Atlas Data API that once sidestepped this is deprecated. The free cluster is
  smaller than D1 (0.5 GB vs 5 GB), can't enable backups (D1 gets 7-day point-in-time restore
  free), and **pauses after 30 days with zero connections** — the Supabase problem again. It
  would also add a runtime dependency and a third store to keep in parity. The one real gap it
  pointed at — Learn search can't see inside pages — is better fixed offline, over the
  already-precached `learn-data.js`.
- **A traditional VPS** (e.g. a $5/mo droplet) — predictable but not free, and you manage the server.
  Cloudflare's free tier beats it until real scale.

## Sources

- [Vercel Hobby plan docs](https://vercel.com/docs/plans/hobby) · [Vercel free-tier limits 2026](https://deploywise.dev/blog/vercel-free-tier-limits-2026)
- [Supabase free-tier limits 2026](https://aiagencyplus.com/supabase-free-tier-limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [Workers & Pages pricing](https://www.cloudflare.com/plans/developer-platform/)
- [Hyperdrive supported databases](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) · [Workers best practices (per-request connection cost)](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) · [MongoDB on Workers, measured latency (2025)](https://alexbevi.com/blog/2025/04/11/performance-profiling-mongodb-on-cloudflare-workers/) · [Atlas Data API (deprecated)](https://www.mongodb.com/docs/api/doc/atlas-data-api-v1/) · [Atlas free-cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
