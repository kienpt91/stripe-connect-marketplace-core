#!/bin/sh
# Run a command in a throwaway Node 24 container. Nothing from the project is installed or built on the host.
#
#   scripts/node.sh install            npm ci --ignore-scripts into a docker volume (the only step with network access)
#   scripts/node.sh add PKG...         npm install --save-exact --ignore-scripts --before=CUTOFF PKG... (writes package.json and the lockfile)
#   scripts/node.sh lock               npm install --package-lock-only --ignore-scripts --before=CUTOFF (writes the lockfile from package.json)
#   scripts/node.sh "COMMAND"          run a shell command with the project on PATH, no network
#
# The project is mounted read-only. The only writable places are ./out (coverage, reports), ./dist (build output),
# /tmp (tmpfs) and the node_modules volume. The container has no access to $HOME or the host environment, drops every
# capability, runs as the calling user and is limited to 4 CPUs and 6 GiB.
#
#   NODE_NET=...        docker network of the container for a command (default none); the integration script uses
#                       container:NAME to reach a database container that has no network of its own
#   NODE_CPUS=2         CPU limit (default 4; the CI runners have 2)
#
# The image is the official node image pinned by the digest of its multi-arch index: node 24.14.1, built 2026-04-07,
# older than the seven day policy at the time of pinning (2026-11-07). The dependency cutoff is the date before which a
# package version must have been published to be installed (2026-10-24, two weeks before the pinning).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
image=${NODE_IMAGE:-node@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c}
cutoff=2026-10-24T00:00:00Z
name=$(basename "$here")
vol="node-modules-$name"
[ $# -ge 1 ] || { echo "usage: node.sh install | add PKG... | lock | COMMAND" >&2; exit 2; }
mkdir -p "$here/out" "$here/dist"
docker volume create "$vol" > /dev/null
# the volume must be owned by the unprivileged user
docker run --rm -u 0 -v "$vol:/nm" "$image" chown "$(id -u):$(id -g)" /nm > /dev/null

mode=ro
net=${NODE_NET:-none}
case "$1" in
  install)
    net=bridge
    cmd='npm ci --ignore-scripts --no-audit --no-fund'
    ;;
  add)
    shift
    net=bridge
    mode=rw
    cmd="npm install --before=$cutoff --ignore-scripts --save-exact --no-audit --no-fund $*"
    ;;
  lock)
    net=bridge
    mode=rw
    cmd="npm install --package-lock-only --before=$cutoff --ignore-scripts --no-audit --no-fund"
    ;;
  *)
    cmd="$*"
    ;;
esac
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --cpus "${NODE_CPUS:-4}" --memory 6g --pids-limit 1024 \
  --network "$net" \
  --read-only --tmpfs /tmp:rw,exec,size=1g \
  -e HOME=/tmp/home -e npm_config_cache=/tmp/npm-cache -e npm_config_update_notifier=false \
  -v "$here:/work:$mode" -v "$here/out:/work/out" -v "$here/dist:/work/dist" -v "$vol:/work/node_modules" -w /work \
  "$image" sh -c "$cmd"
