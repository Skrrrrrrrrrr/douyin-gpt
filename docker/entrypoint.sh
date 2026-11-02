#!/bin/sh
set -eu
mkdir -p /data
chown node:node /data
exec gosu node flock --nonblock --no-fork /data/.container.lock "$@"
