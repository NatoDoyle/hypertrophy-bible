// A minimal Cloudflare D1-compatible wrapper over Node's built-in `node:sqlite`
// (real SQLite, same engine D1 runs on), used ONLY by test-store-d1.mjs to
// exercise src/store-d1.mjs against a real database instead of "reviewed by
// hand" — the store interface (prepare/bind/first/all/run/batch/exec) mirrors
// the subset of the D1 binding API that src/store-d1.mjs actually calls.
// node:sqlite ships in Node >= 22.5 — imported lazily by sqliteAvailable()/
// createD1Shim() so environments on older Node can detect-and-skip instead of
// crashing at module load (the parity suite self-skips there; it still runs
// fully on Node 22+, e.g. the cloud-loop sessions).
let DatabaseSync = null;
export async function sqliteAvailable() {
  if (DatabaseSync) return true;
  try { ({ DatabaseSync } = await import("node:sqlite")); return true; } catch { return false; }
}

function wrapStatement(raw, sql, boundArgs) {
  return {
    bind(...args) { return wrapStatement(raw, sql, args); },
    async first() {
      const row = raw.prepare(sql).get(...boundArgs);
      return row ?? null;
    },
    async all() {
      const results = raw.prepare(sql).all(...boundArgs);
      return { results };
    },
    async run() {
      const info = raw.prepare(sql).run(...boundArgs);
      return { meta: { changes: info.changes } };
    },
  };
}

export function createD1Shim() {
  const raw = new DatabaseSync(":memory:");
  return {
    exec(sql) { raw.exec(sql); },
    prepare(sql) { return wrapStatement(raw, sql, []); },
    // Real D1 runs a batch as one implicit transaction; mirror that so the
    // all-or-nothing semantics store-d1.mjs's comments rely on are genuine,
    // not just documented.
    async batch(stmts) {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const s of stmts) results.push(await s.run());
        raw.exec("COMMIT");
        return results;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
