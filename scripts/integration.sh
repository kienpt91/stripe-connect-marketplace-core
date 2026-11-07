#!/bin/sh
# Run the whole test suite, the tests that need PostgreSQL included, against a throwaway database container.
#
# The database is the official postgres:16.14 image pinned by digest (built 2026-08-05, older than the seven day
# policy). It runs with NO network at all (--network none), a read-only root, a tmpfs data directory, no capabilities and an
# unprivileged user. The test process runs in the Node container of scripts/node.sh, which joins the database container's
# network namespace, so the server is reached at 127.0.0.1 and nothing else is reachable. The superuser password is
# generated here, written to a mode-600 file under out/ (ignored by git) and removed with the containers on exit.
#
# The server runs with PostgreSQL's DEFAULT max_connections (100, of which 3 are reserved for superusers), the same as the service
# container of the CI job, so a suite that needs more connections fails here the way it fails there. PG_MAX_CONNECTIONS overrides it.
#
# usage: scripts/integration.sh [vitest arguments...]      (runs: vitest run --coverage ARGS)
set -eu
cd "$(dirname "$0")/.."
image=postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b
suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
pg=marketplace-it-pg-$suffix

mkdir -p out
( umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > out/.it-secret )

cleanup() {
  docker rm -f -v "$pg" >/dev/null 2>&1 || true
  rm -f out/.it-secret
}
trap cleanup EXIT INT TERM

POSTGRES_PASSWORD=$(cat out/.it-secret) docker run -d --name "$pg" --network none \
  --pull never --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --cpus "${NODE_CPUS:-4}" --memory 6g \
  --user 999:999 --read-only \
  --tmpfs /var/lib/postgresql/data:rw,uid=999,gid=999,mode=0700 \
  --tmpfs /var/run/postgresql:rw,uid=999,gid=999,mode=0755 --tmpfs /tmp:rw,mode=1777 \
  -e POSTGRES_PASSWORD "$image" -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=${PG_MAX_CONNECTIONS:-100} >/dev/null

i=0
until docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "integration: the database did not become ready" >&2; docker logs "$pg" >&2 || true; exit 1; fi
  sleep 0.5
done

args=""
for a in "$@"; do args="$args '$a'"; done
NODE_NET="container:$pg" scripts/node.sh \
  "MARKETPLACE_TEST_DATABASE_URL=\"postgres://postgres:\$(cat out/.it-secret)@127.0.0.1:5432/postgres\" npx vitest run --coverage $args"
