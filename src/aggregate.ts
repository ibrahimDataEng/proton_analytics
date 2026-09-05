import {
	ACTIVE_PRODUCTS_KEY,
	ACTIVE_WINDOW_SECONDS,
	SCORE_WINDOW_HOURS,
	UPSERT_CHUNK_SIZE,
} from "./config";
import { pool } from "./db";
import { describeError } from "./errors";
import { redis } from "./redis";
import { hourBucket, viewKey } from "./tracking";

interface ProductScore {
	productId: string;
	score: number;
	viewCount24h: number;
}

/**
 * Decayed score: a view in the current hour is worth 1, one 1h ago 1/2, 23h ago 1/24.
 * `view_count_24h` is the plain unweighted total, kept alongside for display/debugging.
 */
function computeScore(counts: number[]): { score: number; viewCount24h: number } {
	let score = 0;
	let viewCount24h = 0;
	counts.forEach((count, hoursAgo) => {
		score += count / (hoursAgo + 1);
		viewCount24h += count;
	});
	return { score, viewCount24h };
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

async function upsertScores(rows: ProductScore[]): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
			const values: (string | number)[] = [];
			const tuples = batch.map((row, index) => {
				const offset = index * 3;
				values.push(row.productId, row.score, row.viewCount24h);
				return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
			});
			await client.query(
				`INSERT INTO product_trending_scores (product_id, score, view_count_24h)
				 VALUES ${tuples.join(", ")}
				 ON CONFLICT (product_id) DO UPDATE SET
					score = EXCLUDED.score,
					view_count_24h = EXCLUDED.view_count_24h,
					updated_at = now()`,
				values,
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

/**
 * One aggregation cycle. Never throws — a failed run logs and leaves the next
 * scheduled run to retry, so a transient Redis/Postgres blip can't kill the process.
 */
export async function runAggregation(now: Date = new Date()): Promise<void> {
	const startedAt = Date.now();
	try {
		const nowSeconds = Math.floor(now.getTime() / 1000);

		// Drop products not viewed in the last 48h.
		await redis.zremrangebyscore(ACTIVE_PRODUCTS_KEY, "-inf", nowSeconds - ACTIVE_WINDOW_SECONDS);

		const productIds = await redis.zrange(ACTIVE_PRODUCTS_KEY, 0, -1);
		if (productIds.length === 0) {
			console.log(`[aggregate] 0 products processed in ${Date.now() - startedAt}ms`);
			return;
		}

		const buckets = Array.from({ length: SCORE_WINDOW_HOURS }, (_, hoursAgo) =>
			hourBucket(new Date(now.getTime() - hoursAgo * 3_600_000)),
		);

		// One MGET per product, all pipelined into a single round-trip.
		const pipeline = redis.pipeline();
		for (const productId of productIds) {
			pipeline.mget(buckets.map((bucket) => viewKey(productId, bucket)));
		}
		const results = await pipeline.exec();

		const rows: ProductScore[] = productIds.map((productId, index) => {
			const [error, raw] = results?.[index] ?? [null, null];
			if (error) {
				throw error;
			}
			// Missing keys come back as null and count as zero views for that hour.
			const counts = ((raw as (string | null)[] | null) ?? []).map((value) => Number(value ?? 0) || 0);
			const { score, viewCount24h } = computeScore(counts);
			return { productId, score, viewCount24h };
		});

		await upsertScores(rows);
		console.log(`[aggregate] ${rows.length} products processed in ${Date.now() - startedAt}ms`);
	} catch (error) {
		console.error(`[aggregate] run failed after ${Date.now() - startedAt}ms: ${describeError(error)}`);
	}
}
