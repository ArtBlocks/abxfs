import { Command } from "commander";
import kleur from "kleur";

import { autoRegisterNodeCodecs, asAbxfsCid } from "@abxfs/sdk";

import { createClient } from "../client.js";
import { loadConfig, resolveChain } from "../config.js";
import { ipfsCidText } from "../text.js";
import { deriveIpfsCid } from "./pin.js";

export function verifyCommand(): Command {
  return new Command("verify")
    .description("Verify an ABX FS CID resolves to a known IPFS CID (on-chain + local)")
    .argument("<cid>", "bytes32 CID of an ABX FS file or directory")
    .option("-c, --chain <name>", "the network (else ABXFS_CHAIN, else defaultChain)")
    .option("--on-chain", "only query the on-chain resolver")
    .option("--local", "only compute locally")
    .action(async (cid: string, opts: { chain?: string; onChain?: boolean; local?: boolean }) => {
      await autoRegisterNodeCodecs();
      const cfg = loadConfig();
      const chain = resolveChain(cfg, opts.chain);
      const client = createClient(chain);

      const hexCid = asAbxfsCid(cid as `0x${string}`);
      if (opts.onChain) {
        const ipfs = await client.verifyOnChainIpfsCid(hexCid);
        console.log(kleur.green("on-chain"), ipfsCidText(ipfs));
        return;
      }
      if (opts.local) {
        const ipfs = await client.verifyLocalIpfsCid(hexCid);
        console.log(kleur.green("local"), ipfsCidText(ipfs));
        return;
      }
      // Both, compared. The resolver cannot decode an off-chain file codec (`CodecNotSupported`), and a chain may have
      // no resolver; then there is no on-chain value, and the local derivation is reported on its own.
      const derived = await deriveIpfsCid(client, hexCid);
      const local = derived.where === "on-chain" ? await client.verifyLocalIpfsCid(hexCid) : derived.cid;
      if (derived.where === "on-chain") {
        console.log(kleur.green("on-chain"), ipfsCidText(derived.cid));
        console.log(kleur.green("local   "), ipfsCidText(local));
        if (derived.cid !== local) throw new Error(`IPFS CID mismatch: on-chain=${ipfsCidText(derived.cid)}, local=${ipfsCidText(local)}`);
        console.log(kleur.green("✓ match"));
        return;
      }
      console.log(kleur.green("local"), ipfsCidText(local));
      console.log(
        kleur.gray(
          client.addresses.ipfsCidResolver
            ? "  the on-chain resolver cannot decode this content's file codec, so there is no on-chain value to compare"
            : "  this chain has no on-chain IPFS CID resolver, so there is no on-chain value to compare",
        ),
      );
    });
}
