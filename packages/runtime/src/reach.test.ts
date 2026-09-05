import { describe, expect, it } from "vitest";

import type { ResourceReach } from "@aicoo/sharedos-contracts";

import { DEFAULT_DESCRIBED_REACH_LIMIT, describeReach } from "./index.js";

const ATLAS: ResourceReach = {
  namespace: "files",
  path: ["Work", "Projects", "atlas"],
  actions: ["read", "search"],
  scope: "descendants",
};

const INBOX: ResourceReach = {
  namespace: "sharedos.messaging",
  path: ["inbox"],
  actions: ["read"],
  scope: "exact",
};

describe("describeReach", () => {
  it("lists each entry in the shape the tools take, after saying the list decides nothing", () => {
    const text = describeReach({ status: "computed", reach: [ATLAS, INBOX] });
    const [header, ...entries] = text.split("\n");

    expect(header).toContain("every call is still decided on its own");
    expect(header).toContain("nothing here is a permission");
    // The path is the JSON array a `path` argument is, so the model can copy it.
    expect(entries).toEqual([
      '- files ["Work","Projects","atlas"] and everything beneath it: read, search',
      '- sharedos.messaging ["inbox"] only: read',
    ]);
  });

  it("names the root rather than printing an empty array", () => {
    const text = describeReach({
      status: "computed",
      reach: [{ namespace: "files", path: [], actions: ["read"], scope: "descendants" }],
    });

    expect(text).toContain("- files the root and everything beneath it: read");
    expect(text).not.toContain("[]");
  });

  it("says nowhere for an empty reach, so the model is not left to guess", () => {
    const text = describeReach({ status: "computed", reach: [] });

    expect(text).toContain("nowhere");
    expect(text).toContain("a description, not a refusal");
    expect(text).not.toContain("\n- ");
  });

  it("keeps unavailable distinct from empty, and names the reason code", () => {
    const usage = describeReach({ status: "unavailable", reasonCode: "usage_store_unavailable" });
    const authority = describeReach({
      status: "unavailable",
      reasonCode: "authority_unavailable",
    });

    for (const text of [usage, authority]) {
      expect(text).toContain("could not be established");
      // "Unknown" must never read as "nothing"; ADR 0021 hands the branch over
      // so a renderer does not collapse it.
      expect(text).toContain("This is not an empty list");
      expect(text).not.toContain("nowhere");
      expect(text).toContain("refused under the same code");
    }
    expect(usage).toContain("usage_store_unavailable");
    expect(usage).toContain("budget could not be read");
    expect(authority).toContain("authority_unavailable");
    expect(authority).toContain("could not be loaded");
  });

  it("counts what it leaves out past the limit, so a cut list never reads as complete", () => {
    const reach = Array.from({ length: DEFAULT_DESCRIBED_REACH_LIMIT + 3 }, (_, index) => ({
      ...ATLAS,
      path: ["Work", String(index)],
    }));
    const text = describeReach({ status: "computed", reach });
    const lines = text.split("\n");

    expect(lines.filter((line) => line.startsWith("- files"))).toHaveLength(
      DEFAULT_DESCRIBED_REACH_LIMIT,
    );
    expect(lines.at(-1)).toBe("- and 3 more entries not listed.");

    expect(describeReach({ status: "computed", reach }, { limit: reach.length - 1 })).toContain(
      "- and 1 more entry not listed.",
    );
    expect(describeReach({ status: "computed", reach }, { limit: reach.length })).not.toContain(
      "not listed",
    );
  });

  it("refuses a limit that is not a count", () => {
    // Zero included: a header that promises lines and then lists none is not a
    // description, it is a puzzle.
    for (const limit of [0, -1]) {
      expect(() => describeReach({ status: "computed", reach: [] }, { limit })).toThrow(TypeError);
    }
    expect(() => describeReach({ status: "computed", reach: [] }, { limit: 1.5 })).toThrow(
      TypeError,
    );
  });
});
