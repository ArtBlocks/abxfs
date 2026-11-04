/**
 * Audit 4: the generation list an address book implies must be coherent. The canonical registry carries no addresses
 * until ABX FS is deployed, so these run against a stand-in book with a current and a previous generation.
 */
import { describe, expect, it } from "vitest";
import { orgGenerations, type ContractAddresses, type OrgGeneration } from "../../src/index.js";
import { fixtureAddresses } from "../helpers/deployed-registry.js";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const PREV: OrgGeneration = { orgFactory: at(0xa1), projectHook: at(0xa2), orgMinter: at(0xa3), projectEnumeration: at(0xa4), lens: at(0xa5) };
const book = (): ContractAddresses => ({ ...fixtureAddresses(84532), previousGenerations: [PREV] });

describe("Audit4 generations", () => {
  it("a registry with a current and a previous generation is coherent and has no duplicate factories", () => {
    const gens = orgGenerations(book());
    expect(gens).toHaveLength(2);
    const f = gens.map((g) => g.orgFactory.toLowerCase());
    expect(new Set(f).size).toBe(f.length);
    // The current generation leads.
    expect(gens[0]!.orgFactory).toBe(book().orgFactory);
  });
  it("same hook under two factories is refused", () => {
    const d = book();
    const bad = { ...d, previousGenerations: [{ ...PREV, projectHook: d.projectHook! }] };
    expect(() => orgGenerations(bad)).toThrow(/incoherent/);
  });
  it("one factory listed with two different hooks is refused", () => {
    const d = book();
    const bad = { ...d, previousGenerations: [{ ...PREV, orgFactory: d.orgFactory! }] };
    expect(() => orgGenerations(bad)).toThrow(/incoherent/);
  });
  it("a casing-only difference of the same factory is treated as the same generation", () => {
    const d = book();
    const prev = { orgFactory: d.orgFactory!.toUpperCase().replace("0X", "0x"), orgMinter: d.orgMinter!, projectHook: d.projectHook!, projectEnumeration: d.projectEnumeration!, lens: d.lens! };
    const gens = orgGenerations({ ...d, previousGenerations: [prev as never, ...(d.previousGenerations ?? [])] });
    expect(gens.filter((g) => g.orgFactory.toLowerCase() === d.orgFactory!.toLowerCase()).length).toBe(1);
  });
});
