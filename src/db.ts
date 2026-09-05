import { Pool } from "pg";
import { config } from "./config";
import { describeError } from "./errors";

/** Single shared pool for the whole process — never create a client per request. */
export const pool = new Pool({
	connectionString: config.databaseUrl,
	max: 10,
	idleTimeoutMillis: 30_000,
});

pool.on("error", (err: Error) => {
	console.error(`[db] idle client error: ${describeError(err)}`);
});

/**
 * Creates this service's only table. Deliberately uniquely named so it cannot collide
 * with any Saleor table sharing the same database. Idempotent — safe to run every boot.
 */
export async function ensureSchema(): Promise<void> {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS product_trending_scores (
			product_id TEXT PRIMARY KEY,
			score DOUBLE PRECISION NOT NULL DEFAULT 0,
			view_count_24h INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`);
}

export async function closeDb(): Promise<void> {
	await pool.end();
}
