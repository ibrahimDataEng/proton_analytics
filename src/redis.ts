import Redis from "ioredis";
import { config } from "./config";
import { describeError } from "./errors";

/**
 * Single shared connection for the whole process — never create a client per request.
 * `lazyConnect` is off so connection problems surface at startup rather than on first view.
 */
export const redis = new Redis(config.redisUrl, {
	maxRetriesPerRequest: 3,
	retryStrategy: (times) => Math.min(times * 200, 5_000),
});

// Without a listener, ioredis emits an unhandled 'error' event that would kill the process
// on a transient Redis blip. Logging keeps the service alive while it reconnects.
redis.on("error", (err: Error) => {
	console.error(`[redis] connection error: ${describeError(err)}`);
});

export async function closeRedis(): Promise<void> {
	try {
		await redis.quit();
	} catch {
		redis.disconnect();
	}
}
