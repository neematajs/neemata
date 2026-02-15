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

Run both backends with one command:

```bash
pnpm run test:e2e:jobs:docker
```

This command rebuilds the test image on each run and executes Redis + Valkey suites in one pass.

Run Jobs E2E directly in Docker:

```bash
docker compose -f docker-compose.jobs-e2e.yml run --rm --build test-jobs
```

Manual Docker control:

```bash
docker compose -f docker-compose.jobs-e2e.yml up -d --wait redis valkey
docker compose -f docker-compose.jobs-e2e.yml run --rm --build test-jobs
docker compose -f docker-compose.jobs-e2e.yml down -v --remove-orphans
```