// Local dev entry: file-backed store + static frontend, on plain Node.
// (Production uses worker.mjs with a D1-backed store — same Hono app.)
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.mjs";
import { createFileStore } from "./src/store.mjs";
import { createEmailSender } from "./src/email.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const store = createFileStore(join(dir, ".data", "store.json"));
// No RESEND_API_KEY locally -> the sender logs the magic link instead of mailing.
const sendEmail = createEmailSender({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
// exposeDevLink: surface the magic link in the API response for local testing only.
const app = createApp(store, { sendEmail, exposeDevLink: !process.env.RESEND_API_KEY });

// Static frontend (API routes are registered first, so they win).
app.get("/", serveStatic({ path: "./public/index.html" }));
app.get("/*", serveStatic({ root: "./public" }));

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
serve({ fetch: app.fetch, port }, (info) =>
  console.log(`\n  Hypertrophy Bible app → http://localhost:${info.port}\n`)
);
