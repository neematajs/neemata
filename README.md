# NeemataJS - RPC application server for real-time applications (proof of concept)

### Built with following in mind:
- transport-agnostic (like WebSockets, WebTransport, .etc)
- format-agnostic (like JSON, MessagePack, BSON, .etc)
- binary data streaming and event subscriptions
- contract-based API
- end-to-end type safety
- CPU-intensive task execution on separate workers

## Jobs E2E (Local Docker)

Prerequisites:
- Docker Desktop (or Docker Engine) with `docker compose` available

No host ports are exposed in this setup. Tests run fully inside Docker containers.
The test image is optimized for Docker layer caching with `pnpm fetch` + offline install.

Run Jobs E2E with Redis:

```bash
docker compose -f docker-compose.jobs-e2e.yml run --rm test-redis
```

Run Jobs E2E with Valkey:

```bash
docker compose -f docker-compose.jobs-e2e.yml run --rm test-valkey
```

Manual Docker control:

```bash
docker compose -f docker-compose.jobs-e2e.yml up -d --wait redis
docker compose -f docker-compose.jobs-e2e.yml run --rm test-redis
pnpm run docker:jobs:down
```

```bash
docker compose -f docker-compose.jobs-e2e.yml up -d --wait valkey
docker compose -f docker-compose.jobs-e2e.yml run --rm test-valkey
pnpm run docker:jobs:down
```