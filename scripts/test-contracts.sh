#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for pkg in protobuf-sol contracts-core contracts-companion contracts-projects; do
  echo ""
  echo "=== forge test: packages/${pkg} ==="
  ( cd "${ROOT}/packages/${pkg}" && forge test -vvv )
done
