# E2E Tests

These tests use real external services. They do not start Docker.

Local Docker setup:

```sh
docker compose -f tests/e2e/compose.yml up -d --wait
```

Run Redis-backed tests:

```sh
REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @nmtjs/tests-e2e run test
```

Run Kafka-backed tests:

```sh
KAFKA_BROKERS=127.0.0.1:9092 pnpm --filter @nmtjs/tests-e2e run test
```

When an env var is missing, matching tests are skipped.

Stop local services:

```sh
docker compose -f tests/e2e/compose.yml down -v
```
