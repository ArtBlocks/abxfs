#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for pkg in protobuf-sol contracts-core contracts-companion; do
  echo ""
  echo "=== forge snapshot: packages/${pkg} ==="
  ( cd "${ROOT}/packages/${pkg}" && forge snapshot --check || forge snapshot )
done
