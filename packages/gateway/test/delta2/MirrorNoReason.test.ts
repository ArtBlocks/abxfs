/**
 * DELTA-2: the mirror's tree check with a filter that refuses WITHOUT a reason (a custom filter may say only
 * `{ allow: false }`): the skip still says why, as "filtered", rather than "undefined".
 */
import { describe, expect, it } from "vitest";
import { ProjectKind } from "@abxfs/sdk";

import { RootContainsBlockedError, assessRoot } from "../../src/mirror.js";
import { rootSubject } from "../../src/subjects.js";
import type { GatewayChain } from "../../src/types.js";
import { FakeChain } from "../fake-chain.js";

describe("assessRoot with a filter that gives no reason", () => {
  it("refuses the tree and says 'filtered'", async () => {
    const fc = new FakeChain();
    const file = fc.addFile([new TextEncoder().encode("bytes")], "text/html").cid;
    const dir = fc.addDirectory([{ name: "index.html", cid: file, isDirectory: false }]);
    const chain: GatewayChain = { id: 84532, contracts: fc.contracts as never, client: fc.client as never };
    const err = await assessRoot(chain, dir, ProjectKind.Directory, {}, { filter: () => ({ allow: false }), subjects: [rootSubject(dir)] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RootContainsBlockedError);
    expect((err as Error).message).toMatch(/it holds a CID the filter refuses \(filtered\), inside directory/);
  });
});
