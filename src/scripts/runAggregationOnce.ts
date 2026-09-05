/**
 * Runs a single aggregation cycle then exits. Useful for local verification and
 * for forcing a refresh without waiting for the 10-minute schedule.
 *
 *   npm run aggregate:once
 */
import { runAggregation } from "../aggregate";
import { closeDb, ensureSchema } from "../db";
import { closeRedis } from "../redis";

async function main(): Promise<void> {
	await ensureSchema();
	await runAggregation();
	await Promise.allSettled([closeRedis(), closeDb()]);
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error("[aggregate:once] failed:", error);
		process.exit(1);
	});
