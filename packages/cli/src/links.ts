/**
 * Where a project or a root can be seen, printed after a write and by `info`. Every link is read from chain: a token's
 * from the renderer its metadata uses (`readTokenLinks`), a root's from the gateway base frozen into `OrgMeta`, so the
 * CLI names no domain itself. A failed read is a note, never an error: the write before it has already succeeded.
 */
import kleur from "kleur";
import { orgMetaAbi, type AbxfsClient, type AbxfsCid } from "@artblocks/abxfs-sdk";

import { redact } from "./redact.js";
import { safe } from "./text.js";

const reason = (e: unknown) => redact(e instanceof Error ? e.message.split("\n")[0]! : String(e));

/**
 * The live project and the token's `external_url` (its page), as the org's links renderer renders them. The first is the
 * token's `animation_url` only in orgs from the original factory: an org with `projectPresentation` renders its
 * animation from the presentation settings, so the line says so instead. After a write they lead with a check mark
 * like the lines before them; `info` prints them as two more fields.
 */
export async function printProjectLinks(
  client: Pick<AbxfsClient, "readTokenLinks" | "addresses">,
  tokenId: bigint,
  opts: { afterWrite?: boolean } = { afterWrite: true },
): Promise<void> {
  try {
    const { animationUrl, externalUrl } = await client.readTokenLinks(tokenId);
    const lead = opts.afterWrite ? [kleur.green("✓"), "live at:"] : ["  live at: "];
    const animation = client.addresses.projectPresentation
      ? "(the links renderer's animation_url, used by orgs from the original factory; this token's animation follows " +
        "its presentation: abxfs presentation inspect)"
      : "(the token's animation_url)";
    console.log(...lead, safe(animationUrl), kleur.gray(animation));
    console.log(opts.afterWrite ? "  page:   " : "  page:    ", safe(externalUrl), kleur.gray("(the token's external_url)"));
  } catch (e) {
    console.log(kleur.gray(`  (could not read the project's links: ${reason(e)})`));
  }
}

/** A root with no project: the gateway's `/g/cid/<chain>/<root>/`, which redirects to the root's own host. */
export async function printRootLink(
  client: Pick<AbxfsClient, "publicClient" | "addresses">,
  chainId: number,
  root: AbxfsCid,
): Promise<void> {
  const orgMeta = client.addresses.orgMeta;
  if (!orgMeta) return;
  try {
    const base = await client.publicClient.readContract({ address: orgMeta, abi: orgMetaAbi, functionName: "gatewayBase" });
    console.log(kleur.green("✓"), "served at:", safe(`${base}/g/cid/${chainId}/${root}/`));
  } catch (e) {
    console.log(kleur.gray(`  (could not read the gateway's address: ${reason(e)})`));
  }
}
