import express, { type Request, type Response } from "express";
import cron from "node-cron";
import { runAggregation } from "./aggregate";
import { config } from "./config";
import { closeDb, ensureSchema, pool } from "./db";
import { describeError } from "./errors";
import { closeRedis, redis } from "./redis";
import { recordView } from "./tracking";

const DEFAULT_TRENDING_LIMIT = 10;
const MAX_TRENDING_LIMIT = 50;

export const app = express();
app.use(express.json());

app.post("/track-view", async (req: Request, res: Response) => {
	const productId: unknown = req.body?.productId;
	if (typeof productId !== "string" || productId.trim() === "") {
		return res.status(400).json({ error: "productId must be a non-empty string" });
	}

	try {
		await recordView(productId.trim());
		return res.status(202).json({ status: "accepted" });
	} catch (error) {
		// Redis is unreachable — tell the caller rather than silently dropping the view.
		console.error(`[track-view] failed for "${productId}": ${describeError(error)}`);
		return res.status(503).json({ error: "view could not be recorded" });
	}
});

app.get("/trending", async (req: Request, res: Response) => {
	// Out-of-range and non-numeric values clamp to a sane limit rather than erroring.
	const requested = Number(req.query.limit);
	const limit = Number.isFinite(requested)
		? Math.min(Math.max(Math.trunc(requested), 1), MAX_TRENDING_LIMIT)
		: DEFAULT_TRENDING_LIMIT;

	try {
		const { rows } = await pool.query<{ product_id: string; score: number }>(
			"SELECT product_id, score FROM product_trending_scores ORDER BY score DESC LIMIT $1",
			[limit],
		);
		return res.json({
			products: rows.map((row) => ({ productId: row.product_id, score: row.score })),
		});
	} catch (error) {
		console.error(`[trending] query failed: ${describeError(error)}`);
		return res.status(503).json({ error: "trending data unavailable" });
	}
});

app.get("/health", async (_req: Request, res: Response) => {
	const problems: string[] = [];

	try {
		await redis.ping();
	} catch (error) {
		problems.push(`redis: ${describeError(error)}`);
	}

	try {
		await pool.query("SELECT 1");
	} catch (error) {
		problems.push(`postgres: ${describeError(error)}`);
	}

	if (problems.length > 0) {
		return res.status(503).json({ status: "error", problems });
	}
	return res.json({ status: "ok" });
});

async function main(): Promise<void> {
	await ensureSchema();
	console.log("[startup] schema ready");

	// Every 10 minutes. runAggregation swallows its own errors, so a failed run
	// never propagates here and never stops the schedule.
	const task = cron.schedule("*/10 * * * *", () => {
		void runAggregation();
	});

	const server = app.listen(config.port, () => {
		console.log(`[startup] listening on port ${config.port}`);
	});

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[shutdown] received ${signal}, closing`);
		task.stop();
		server.close();
		await Promise.allSettled([closeRedis(), closeDb()]);
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error("[startup] failed:", error);
		process.exit(1);
	});
}
