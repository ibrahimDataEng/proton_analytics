import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const config = {
	port: Number(process.env.PORT ?? 4000),
	redisUrl: required("REDIS_URL", "redis://localhost:6379/2"),
	databaseUrl: required("DATABASE_URL", "postgres://saleor:saleor@localhost:5432/saleor"),
};

/** Hourly view buckets self-expire after ~50h, well past the 24h aggregation window. */
export const VIEW_KEY_TTL_SECONDS = 180_000;

/** Products untouched for 48h are dropped from the active set. */
export const ACTIVE_WINDOW_SECONDS = 172_800;

/** Number of hourly buckets summed into a score. */
export const SCORE_WINDOW_HOURS = 24;

export const ACTIVE_PRODUCTS_KEY = "active_products";

/** Rows per INSERT statement during the batch upsert (keeps well under Postgres' parameter cap). */
export const UPSERT_CHUNK_SIZE = 500;
