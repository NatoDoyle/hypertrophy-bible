// Local dev entry: file-backed store + static frontend, on plain Node.
// (Production uses worker.mjs with a D1-backed store — same Hono app.)
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.mjs";
import { createFileStore } from "./src/store.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const store = createFileStore(join(dir, ".data", "store.json"));
const app = createApp(store);

// Static frontend (API routes are registered first, so they win).
app.get("/", serveStatic({ path: "./public/index.html" }));
app.get("/*", serveStatic({ root: "./public" }));

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
serve({ fetch: app.fetch, port }, (info) =>
  console.log(`\n  Hypertrophy Bible app → http://localhost:${info.port}\n`)
);
