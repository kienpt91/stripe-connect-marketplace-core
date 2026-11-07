#!/bin/sh
# Run the offline demonstration (onboarding, checkout, signed webhooks in the wrong order, a lost event, reconciliation, attacks)
# against a throwaway PostgreSQL container. The database is the postgres:16.14 image pinned by digest, with no network at all;
# the demo runs in the node container of scripts/node.sh, which joins the database container's network namespace. Nothing is
# installed on the host and Stripe is never called: the payment provider is an in-process fake. The build output goes to
# ./dist, the transcript to stdout.
#
# usage: scripts/demo.sh                      print the transcript
#        scripts/demo.sh | tee docs/demo-output.txt
set -eu
cd "$(dirname "$0")/.."
image=postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b
suffix=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
pg=marketplace-demo-pg-$suffix
mkdir -p out
( umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > out/.demo-secret )
cleanup() {
  docker rm -f -v "$pg" >/dev/null 2>&1 || true
  rm -f out/.demo-secret
}
trap cleanup EXIT INT TERM

scripts/node.sh "rm -rf dist/* && npm run build --silent" >&2

POSTGRES_PASSWORD=$(cat out/.demo-secret) docker run -d --name "$pg" --network none \
  --pull never --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --cpus "${NODE_CPUS:-4}" --memory 6g \
  --user 999:999 --read-only \
  --tmpfs /var/lib/postgresql/data:rw,uid=999,gid=999,mode=0700 \
  --tmpfs /var/run/postgresql:rw,uid=999,gid=999,mode=0755 --tmpfs /tmp:rw,mode=1777 \
  -e POSTGRES_PASSWORD "$image" -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200 >/dev/null

i=0
until docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "demo: the database did not become ready" >&2; exit 1; fi
  sleep 0.5
done

NODE_NET="container:$pg" scripts/node.sh \
  "DEMO_ADMIN_URL=\"postgres://postgres:\$(cat out/.demo-secret)@127.0.0.1:5432/postgres\" node dist/bin.js demo"
