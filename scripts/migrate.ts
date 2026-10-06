import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { openPostgresRuntime } from "../src/runtime/postgres-queue.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(734291)");
  await client.query(await readFile(new URL("../src/runtime/schema.sql", import.meta.url), "utf8"));
  if (process.env.SHOPFLOOR_REVIEW_MEMORY === "true") {
    await client.query(await readFile(new URL("../src/runtime/memory-schema.sql", import.meta.url), "utf8"));
  }
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally { client.release(); await pool.end(); }
const runtime = await openPostgresRuntime(url, true);
await runtime.close();
console.info("Shopfloor migrations complete");
