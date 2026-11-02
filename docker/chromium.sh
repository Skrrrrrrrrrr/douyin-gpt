#!/bin/sh
set -eu
# The container runs as an unprivileged user; Chromium's namespace sandbox is
# unavailable in the Docker Desktop runtime. No host profile or Docker socket is mounted.
exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --password-store=basic "$@"
