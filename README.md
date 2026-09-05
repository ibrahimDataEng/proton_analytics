# proton_analytics

Standalone product-view tracking and "trending now" scoring service.

Tracks product page views in Redis, aggregates them every 10 minutes into a
time-decayed trending score, and serves that score over a small REST API for the
storefront homepage to consume.

## Design constraints

This service is **fully independent** of `proton_storefront` and `proton_platform`
(Saleor). It connects to the *existing* Saleor Postgres and Redis instances, but:

- It does **not** modify the Saleor image, Dockerfile, `settings.py`, or `urls.py`.
- It has zero coupling to Saleor's codebase or deployment lifecycle.
- It writes to Redis **db index 2** (Saleor uses db 0 for cache, db 1 for the Celery
  broker) so keys can never collide.
- It owns exactly one, uniquely named Postgres table, `product_trending_scores`,
  in the same `saleor` database. The name was checked against the 18 existing
  `product_*` tables — no collision.

## Environment variables

| Variable       | Local dev                                          | In Docker (shared network)                     |
| -------------- | -------------------------------------------------- | ---------------------------------------------- |
| `PORT`         | `4000`                                             | `4000`                                         |
| `REDIS_URL`    | `redis://localhost:6379/2`                         | `redis://redis:6379/2`                         |
| `DATABASE_URL` | `postgres://saleor:saleor@localhost:5432/saleor`   | `postgres://saleor:saleor@db:5432/saleor`      |

Copy `.env.example` to `.env` to get started. Credentials match
`saleor_platform/backend.env`.

## Running locally

The Saleor stack (`saleor_platform`) must already be up, since this service uses its
Redis and Postgres.

```bash
npm install
cp .env.example .env
npm run dev
```

Other scripts:

```bash
npm run build            # compile TypeScript to dist/
npm start                # run the compiled build
npm run typecheck        # tsc --noEmit
npm run aggregate:once   # force one aggregation cycle instead of waiting 10 minutes
```

### ⚠️ Local Postgres port conflict on this Windows machine

`localhost:5432` on this dev machine does **not** reach the Saleor Postgres container.
A native Windows service (`PostgreSQL_For_Odoo`, PostgreSQL 12) also binds `0.0.0.0:5432`
and wins over Docker's port proxy, so connections land on the wrong database and fail with
`password authentication failed for user "saleor"`.

Redis is unaffected — `localhost:6379` correctly reaches the container.

To work around it without modifying `saleor_platform`, publish the container's Postgres on
a free host port with a throwaway forwarder, and point `DATABASE_URL` at that port:

```bash
docker run --rm -d --name pa-pgforward \
  --network saleor_platform_saleor-backend-tier -p 15432:5432 \
  alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:db:5432
```

Then set `DATABASE_URL=postgres://saleor:saleor@localhost:15432/saleor` in `.env`.
(Host ports in the 55000 range are reserved by Hyper-V on this machine and will fail to
bind; 15432 is known-good.) This affects local dev only — in Docker the service reaches
Postgres directly at `db:5432`, no forwarder needed.

## Running in Docker

```bash
docker build -t proton-analytics:local .

docker run -d --name proton-analytics \
  --network saleor_platform_saleor-backend-tier -p 4000:4000 \
  -e REDIS_URL=redis://redis:6379/2 \
  -e DATABASE_URL=postgres://saleor:saleor@db:5432/saleor \
  proton-analytics:local
```

Adding this service to `saleor_platform`'s `docker-compose.yml` is deliberately **not**
done yet — that is a separate follow-up session.

## API

### `POST /track-view`

Records one view. Redis-only — never touches Postgres, so it stays fast and keeps
working even if Postgres is down.

```
Request:  { "productId": "UHJvZHVjdDoxMjM=" }
202:      { "status": "accepted" }
400:      { "error": "productId must be a non-empty string" }
503:      { "error": "view could not be recorded" }        // Redis unreachable
```

No authentication — this service is internal-network only and must never be exposed
publicly. It is called server-side from `proton_storefront` over the Docker network.

### `GET /trending?limit=N`

Returns products by descending trending score. `limit` defaults to `10`, is capped at
`50`, and out-of-range or non-numeric values are clamped rather than rejected.

```
200:      { "products": [ { "productId": "...", "score": 13 }, ... ] }
503:      { "error": "trending data unavailable" }         // Postgres unreachable
```

### `GET /health`

Actively checks both dependencies (Redis `PING`, Postgres `SELECT 1`) and names
whichever failed. Used for the Docker healthcheck.

```
200:      { "status": "ok" }
503:      { "status": "error", "problems": ["postgres: AggregateError (code ECONNREFUSED)"] }
```

## Redis key design

| Key                              | Type       | Purpose                                                                 |
| -------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `views:{productId}:{YYYYMMDDHH}` | string     | View counter for one UTC hour. `INCR` on each view, `EXPIRE` 180000s (~50h). |
| `active_products`                | sorted set | Member = productId, score = unix timestamp of last view.                |

`EXPIRE` is re-applied on every increment. That is intentionally redundant: it costs
nothing and guarantees the key self-cleans even if an earlier `EXPIRE` was missed.

`active_products` doubles as the cleanup mechanism — because the score is the last-view
timestamp, `ZREMRANGEBYSCORE active_products -inf {now - 172800}` drops anything untouched
for 48h.

## Postgres schema

```sql
CREATE TABLE IF NOT EXISTS product_trending_scores (
    product_id     TEXT PRIMARY KEY,
    score          DOUBLE PRECISION NOT NULL DEFAULT 0,
    view_count_24h INTEGER NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Created idempotently at startup. No ORM and no migration framework — a single raw
statement is sufficient at this scope. If the schema ever needs to change, add the
`ALTER` alongside it in `src/db.ts`.

## Aggregation job

Runs every 10 minutes (`node-cron`), and:

1. Drops products not viewed in 48h from `active_products`.
2. Reads the remaining active product IDs.
3. Reads each product's last 24 hourly buckets — one `MGET` per product, all pipelined
   into a single round-trip.
4. Computes:
   - `score = Σ count(hoursAgo) / (hoursAgo + 1)` — a view this hour is worth `1`, one
     3h ago `1/4`, one 23h ago `1/24`.
   - `view_count_24h = Σ count(hoursAgo)` — plain unweighted total, for display/debugging.
5. Upserts every row in a single transaction via
   `INSERT ... ON CONFLICT (product_id) DO UPDATE`, chunked at 500 rows per statement to
   stay well under Postgres' parameter cap.

The whole job body is wrapped in `try`/`catch`. A failed run logs and returns; it never
crashes the process, and the next scheduled run simply retries.

Each run logs one line: `[aggregate] 5 products processed in 10ms`.

## Known dependency advisories

`npm audit` reports 5 moderate advisories that can only be cleared by major-version
bumps (`express` 5, `node-cron` 4). Both were assessed and deliberately left:

- **qs** (via `express` 4 / `body-parser`) — DoS via attacker-controlled query strings.
  This service is internal-only and parses a single numeric `limit` param.
- **uuid** (via `node-cron` 3) — missing bounds check when a `buf` argument is passed.
  `node-cron` never passes one.

Revisit if this service is ever exposed beyond the internal network.
