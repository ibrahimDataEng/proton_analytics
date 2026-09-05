import { ACTIVE_PRODUCTS_KEY, VIEW_KEY_TTL_SECONDS } from "./config";
import { redis } from "./redis";

/** UTC hour bucket, e.g. 2026-09-05T14:37Z -> "2026090514". */
export function hourBucket(date: Date): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hour = String(date.getUTCHours()).padStart(2, "0");
	return `${year}${month}${day}${hour}`;
}

export function viewKey(productId: string, bucket: string): string {
	return `views:${productId}:${bucket}`;
}

/**
 * Records a single product view: increments the current hour's counter and
 * refreshes the product's position in the active set.
 *
 * EXPIRE is re-set on every increment. That is intentionally redundant — it costs
 * nothing and guarantees the key self-cleans even if an earlier EXPIRE was missed.
 */
export async function recordView(productId: string, now: Date = new Date()): Promise<void> {
	const key = viewKey(productId, hourBucket(now));
	const nowSeconds = Math.floor(now.getTime() / 1000);

	const results = await redis
		.pipeline()
		.incr(key)
		.expire(key, VIEW_KEY_TTL_SECONDS)
		.zadd(ACTIVE_PRODUCTS_KEY, nowSeconds, productId)
		.exec();

	// pipeline.exec() resolves even when individual commands fail; surface the first error.
	const failure = results?.find(([err]) => err);
	if (failure?.[0]) {
		throw failure[0];
	}
}
