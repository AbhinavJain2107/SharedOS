import type { ReachResult, ReachUnavailableReason, ResourceReach } from "@aicoo/sharedos-contracts";

export interface DescribeReachOptions {
  /**
   * How many entries are written out before the rest are counted instead.
   *
   * A reach may carry thousands of entries, and a prompt that lists them all
   * is a prompt the model reads instead of the task. Past the limit the text
   * says how many were left out, so a truncated description never reads as a
   * complete one. Defaults to {@link DEFAULT_DESCRIBED_REACH_LIMIT}.
   */
  readonly limit?: number;
}

export const DEFAULT_DESCRIBED_REACH_LIMIT = 128;

/**
 * `RuntimeVisibleContext.reach`, as the words a model is shown.
 *
 * The runtime is handed where the turn may operate so a model can be told
 * where to look rather than search `/` and collect denials. This is the telling.
 * It is the one rendering the shipped runtimes share -- the model driver puts
 * it in a system message, the MCP harness runtime hands it over as the
 * server's initialize instructions -- and it is exported so a host writing its
 * own driver says the same thing the same way.
 *
 * Every branch of the result is spoken, because each is a different answer:
 *
 * - `computed` with entries lists each as a place some grant covers, in the
 *   shape the tools take -- the namespace, the path as the JSON array a
 *   `path` argument is, and whether the entry covers what lies beneath it.
 * - `computed` with none says so. That is a true answer for a turn that
 *   reaches nothing, and saying nothing would leave the model to guess.
 * - `unavailable` says the reach could not be established and names the
 *   contract's reason code. It is deliberately not written as an empty list:
 *   the executor went to the trouble of handing over `unavailable` so that
 *   "nothing" and "unknown" stay distinguishable (ADR 0021), and a renderer
 *   that collapsed them would rebuild the silent case at the last hop. A call
 *   that depends on what could not be read fails closed under the same code,
 *   so the code is what lets the model correlate the two.
 *
 * Every rendering says that the text is descriptive: each call is still
 * decided on its own, so an entry here is not a permission and a missing one
 * is not a refusal. Actions are listed as the grants state them, not as the
 * offered tools could exercise them -- `reachThroughTools` narrows by
 * namespace and leaves actions alone -- which is one more reason the model is
 * told the list decides nothing.
 */
export function describeReach(reach: ReachResult, options: DescribeReachOptions = {}): string {
  const limit = options.limit ?? DEFAULT_DESCRIBED_REACH_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("describeReach limit must be a positive integer");
  }

  if (reach.status === "unavailable") {
    return (
      "Where your tools may operate this turn could not be established " +
      `(${reach.reasonCode}: ${unavailableBecause(reach.reasonCode)}). ` +
      "This is not an empty list: grants may cover places this cannot name. " +
      "Every call is still decided on its own, and a call that depends on what " +
      "could not be read is refused under the same code."
    );
  }

  if (reach.reach.length === 0) {
    return (
      "Where your tools may operate this turn: nowhere. No tool you were offered " +
      "currently reaches any resource under the grants in force. Every call is " +
      "still decided on its own; this is a description, not a refusal."
    );
  }

  const lines = [
    "Where your tools may operate this turn. Descriptive, not permissive: every " +
      "call is still decided on its own, and nothing here is a permission. Each " +
      "line is a place some grant covers, so point a tool there rather than " +
      "search for it.",
    ...reach.reach.slice(0, limit).map(describeEntry),
  ];
  const omitted = Math.max(0, reach.reach.length - limit);
  if (omitted > 0) {
    lines.push(`- and ${String(omitted)} more ${omitted === 1 ? "entry" : "entries"} not listed.`);
  }
  return lines.join("\n");
}

function describeEntry(entry: ResourceReach): string {
  const path = entry.path.length === 0 ? "the root" : JSON.stringify(entry.path);
  const scope = entry.scope === "descendants" ? "and everything beneath it" : "only";
  return `- ${entry.namespace} ${path} ${scope}: ${entry.actions.join(", ")}`;
}

function unavailableBecause(reason: ReachUnavailableReason): string {
  switch (reason) {
    case "usage_store_unavailable":
      return "a bounded grant's budget could not be read";
    case "authority_unavailable":
      return "the authority behind this turn could not be loaded again after admission";
  }
}
