#!/usr/bin/env bash
#
# Install the Solidity dependencies a fresh checkout does not have.
#
# `packages/*/lib/` is gitignored and there are no git submodules, so `forge build` on a clean
# clone dies at the first `import {Test} from "forge-std/Test.sol"`. Two separate workflows compile
# contracts — contracts-ci and sdk-ci, the latter for the ABIs the SDK mirrors — so this lives in
# one script rather than being duplicated and drifting.
#
# Every package is installed regardless of which one is being tested: contracts-companion and
# contracts-projects remap through `../contracts-core/lib/`, so core's dependencies must exist even
# when core is not the package under test.
#
# Versions are pinned. `forge install` without a pin resolves to whatever is newest, which would
# make a green build today and a red one tomorrow for reasons unrelated to any commit.
set -euo pipefail

FORGE_STD_TAG="v1.15.0"
SOLADY_TAG="v0.1.26"
# The commits those tags name, checked after cloning. The build keeps solc's metadata hash, so every library source a
# deployed contract compiles (Solady's LibZip, SSTORE2, Multicallable, LibString, LibBytes, Base64) is part of its
# address: a tag moved upstream, or a library file edited or reformatted locally, moves addresses. A wrong commit is
# refused here; a local edit is caught by the address pins.
FORGE_STD_COMMIT="0844d7e1fc5e60d77b68e469bff60265f236c398"
SOLADY_COMMIT="acd959aa4bd04720d640bf4e6a5c71037510cc4b"

install_dep() {
  local dir="$1" repo="$2" tag="$3" commit="$4"
  local name="${repo##*/}"
  if [ -d "$dir/lib/$name" ]; then
    echo "  $dir/lib/$name already present"
    return
  fi
  mkdir -p "$dir/lib"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "https://github.com/$repo" "$dir/lib/$name"
  local got
  got="$(git -C "$dir/lib/$name" rev-parse HEAD)"
  if [ "$got" != "$commit" ]; then
    rm -rf "$dir/lib/$name"
    echo "  $repo@$tag is commit $got, expected $commit: refusing (library sources are part of contract addresses)" >&2
    exit 1
  fi
  # Drop the nested .git so the outer repo does not see a phantom submodule.
  rm -rf "$dir/lib/$name/.git"
  echo "  installed $repo@$tag → $dir/lib/$name"
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

install_dep packages/contracts-core       foundry-rs/forge-std "$FORGE_STD_TAG" "$FORGE_STD_COMMIT"
install_dep packages/contracts-core       Vectorized/solady    "$SOLADY_TAG" "$SOLADY_COMMIT"
install_dep packages/contracts-companion  foundry-rs/forge-std "$FORGE_STD_TAG" "$FORGE_STD_COMMIT"
install_dep packages/protobuf-sol         foundry-rs/forge-std "$FORGE_STD_TAG" "$FORGE_STD_COMMIT"
