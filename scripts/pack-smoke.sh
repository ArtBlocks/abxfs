#!/usr/bin/env bash
# Pack every publishable package exactly as `pnpm publish` would, install the tarballs into an empty
# directory with NO workspace, and run what they ship.
#
# Why this exists: inside the repo everything resolves through the workspace, by direct path, from
# `src/`. None of that is what a user gets. This is the only check that notices a missing `files`
# entry, a broken `exports` map, a dependency that was never declared, or a binary that does nothing
# when started through the symlink npm creates — which is exactly the bug it was written for: the CLI
# installed cleanly and then silently printed nothing.
#
# Offline: no RPC, no registry, nothing published. Run after `pnpm -r --filter "./packages/*" build`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARBALLS="$(mktemp -d)"
CLEAN="$(mktemp -d)"
trap 'rm -rf "$TARBALLS" "$CLEAN"' EXIT

PKGS=(sdk pinning gateway cli)

for p in "${PKGS[@]}"; do
  (cd "$ROOT/packages/$p" && pnpm pack --pack-destination "$TARBALLS" >/dev/null)
done

cd "$CLEAN"
node - "$TARBALLS" <<'NODE'
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const dir = process.argv[2];
const deps = {};
for (const f of fs.readdirSync(dir)) {
  // The name comes from the packed manifest itself, not the file name, so a scope or a version does not matter.
  const { name } = JSON.parse(execFileSync("tar", ["-xOf", path.join(dir, f), "package/package.json"], { encoding: "utf8" }));
  deps[name] = "file:" + path.join(dir, f);
}
fs.writeFileSync("package.json", JSON.stringify({ name: "smoke", private: true, dependencies: deps, overrides: deps }, null, 2));
NODE
npm install --no-audit --no-fund --loglevel=error

fail=0
check() { # name, expected substring, command...
  local name="$1" want="$2"; shift 2
  local out
  out="$("$@" 2>&1 || true)"
  if grep -qF -- "$want" <<<"$out"; then echo "ok    $name"; else echo "FAIL  $name — expected output containing: $want"; echo "$out" | head -5; fail=1; fi
}

BIN="$CLEAN/node_modules/.bin"
# Through the symlink in .bin, as npm and a global install start them.
check "abxfs --help prints usage"        "Usage: abxfs"        "$BIN/abxfs" --help
check "abxfs lists the org commands"     "org"                 "$BIN/abxfs" --help
check "abxfs-gateway --help prints usage" "abxfs-gateway"      "$BIN/abxfs-gateway" --help
check "abxfs-mirror --help prints usage"  "abxfs-mirror"       "$BIN/abxfs-mirror" --help
check "sdk resolves and exports orgs"    "function"            node --input-type=module -e "import('@artblocks/abxfs-sdk').then(m=>console.log(typeof m.readOrg, typeof m.AbxfsClient))"
# The packed SDK's registry is the one the workspace built, whatever it holds (no addresses until a deployment is
# verified). The expected words are assembled at run time: Node prints the source of a script that throws, and
# `check` reads stderr too, so a literal there would pass a check that crashed.
check "sdk ships the canonical registry" "registry: same"     node --input-type=module -e "import('node:url').then((u)=>Promise.all([import('@artblocks/abxfs-sdk'),import(u.pathToFileURL(process.argv[1]).href)])).then(([a,b])=>{const s=(m)=>JSON.stringify(m.CANONICAL_DEPLOYMENTS);console.log(['registry:',s(a)!==undefined&&s(a)===s(b)?'same':'differs'].join(' '))}).catch((e)=>console.log('registry check threw: '+e.message))" "$ROOT/packages/sdk/dist/index.js"
check "gateway exports its subpaths"     "function"            node --input-type=module -e "Promise.all([import('@artblocks/abxfs-gateway'),import('@artblocks/abxfs-gateway/subjects'),import('@artblocks/abxfs-gateway/mirror')]).then(([g,s,m])=>console.log(typeof g.createGateway, typeof s.subjectsForPath, typeof m.runMirror))"

exit $fail
