#!/usr/bin/env sh
set -eu
URL="${HEALTHCHECK_URL:-http://127.0.0.1:8080/health/ready}"
curl --fail --silent --show-error "${URL}"
echo
