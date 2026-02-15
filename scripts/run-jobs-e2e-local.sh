#!/usr/bin/env bash

set -euo pipefail

backend="${1:-redis}"

compose_cmd=(docker compose -f docker-compose.jobs-e2e.yml)

cleanup() {
  "${compose_cmd[@]}" down -v --remove-orphans
}

trap cleanup EXIT

case "$backend" in
  redis)
    service='redis'
    test_cmd='test:e2e:jobs:redis'
    store_port='56379'
    ;;
  valkey)
    service='valkey'
    test_cmd='test:e2e:jobs:valkey'
    store_port='56380'
    ;;
  *)
    echo "Invalid backend: $backend. Expected 'redis' or 'valkey'." >&2
    exit 1
    ;;
esac

"${compose_cmd[@]}" --profile "$backend" up -d --wait "$service"
if [[ "$backend" == 'redis' ]]; then
  REDIS_PORT="$store_port" pnpm run "$test_cmd"
else
  VALKEY_PORT="$store_port" pnpm run "$test_cmd"
fi