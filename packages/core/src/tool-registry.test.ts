import type {
  AccessContext,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@aicoo/sharedos-contracts";
import { describe, expect, it, vi } from "vitest";

import { DuplicateRegistrationError } from "./errors.js";
import { type ToolHandler, ToolRegistry } from "./tool-registry.js";

const NOW = "2026-01-01T00:00:00.000Z";
const NEVER_ABORTED = new AbortController().signal;

const SEARCH_TOOL: ToolDefinition = {
  name: "files.search",
  description: "Search the workspace",
  namespace: "files",
  source: "sharedos",
  readWrite: "read",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  requiredCapability: {
    resource: { namespace: "files", path: ["Workspace"] },
    action: "read",
  },
};

const NOTION_TOOL: ToolDefinition = {
  ...SEARCH_TOOL,
  name: "notion.search",
  namespace: "notion",
  source: "mcp",
  requiredCapability: {
    resource: { namespace: "notion", path: ["workspace-a"] },
    action: "read",
  },
};

const CONTEXT: AccessContext = {
  namespaceId: "world-alpha",
  actor: { kind: "agent", agentId: "a-1" },
  authority: { kind: "human", userId: "u-1" },
  owner: { kind: "human", userId: "u-1" },
  purpose: "test",
  traceId: "trace-1",
  enabledToolNamespaces: ["files", "notion"],
  now: NOW,
};

function call(tool: string): ToolCall {
  return { id: "call-1", tool, arguments: { query: "q" }, traceId: "trace-1", requestedAt: NOW };
}

function succeeded(tool: string): ToolResult {
  return { callId: "call-1", tool, completedAt: NOW, status: "succeeded", output: { hits: [] } };
}

function toolFor(definition: ToolDefinition): ToolHandler {
  return {
    definition,
    parseArguments: vi.fn((arguments_) => arguments_),
    resolveRequirement: vi.fn(() => definition.requiredCapability),
    invoke: vi.fn(async () => Promise.resolve(succeeded(definition.name))),
  };
}

function registryWith(...definitions: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of definitions) {
    registry.register(toolFor(definition));
  }
  return registry;
}

describe("copying a tool registry", () => {
  it("carries every registration, so a copy answers as the registry it came from", () => {
    const source = registryWith(SEARCH_TOOL, NOTION_TOOL);

    const copy = source.copy();

    expect(copy.definitions()).toEqual(source.definitions());
    expect(copy.namespaceCatalog(["files"])).toEqual(source.namespaceCatalog(["files"]));
    expect(copy.has("files.search")).toBe(true);
    expect(copy.get("notion.search")).toBe(source.get("notion.search"));
    expect(copy.get("absent.tool")).toBeUndefined();
  });

  it("shares the registered entry rather than re-deriving it", async () => {
    // The point of copying: what `register` produced is immutable and already
    // validated, so the copy is the same object -- no second schema parse, no
    // second clone -- and it still delegates to the handler that was registered.
    const handler = toolFor(SEARCH_TOOL);
    const source = new ToolRegistry();
    source.register(handler);

    const copied = source.copy().get("files.search");

    expect(copied).toBe(source.get("files.search"));
    expect(copied?.definition).toEqual(SEARCH_TOOL);
    expect(Object.isFrozen(copied?.definition)).toBe(true);
    copied?.parseArguments({ query: "q" });
    expect(handler.parseArguments).toHaveBeenCalledWith({ query: "q" });
    copied?.resolveRequirement?.(CONTEXT, call("files.search"));
    expect(handler.resolveRequirement).toHaveBeenCalledOnce();
    await expect(copied?.invoke(CONTEXT, call("files.search"), NEVER_ABORTED)).resolves.toEqual(
      succeeded("files.search"),
    );
    expect(handler.invoke).toHaveBeenCalledOnce();
  });

  it("shares an entry nothing can mutate, so a copy is still a snapshot", () => {
    // Sharing the entry is only safe if the entry is immutable. Before the
    // copy, every derived registry re-ran `register` and so held its own
    // wrapper; now both registries hold one object, and a writable field on it
    // would let a caller holding either registry swap the definition the other
    // serves -- for a weaker `requiredCapability`, say -- or replace `invoke`.
    const source = registryWith(SEARCH_TOOL);
    const copy = source.copy();
    const entry = copy.get("files.search");

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { definition: ToolDefinition }).definition = {
        ...SEARCH_TOOL,
        requiredCapability: { resource: { namespace: "files", path: [] }, action: "read" },
      };
    }).toThrow(TypeError);
    expect(() => {
      (entry as { invoke: ToolHandler["invoke"] }).invoke = async () => succeeded("files.search");
    }).toThrow(TypeError);
    expect(source.definitions()).toEqual([SEARCH_TOOL]);
  });

  it("still refuses a name the original already registered", () => {
    // Duplicate detection is what keeps a context provider from shadowing a
    // host tool, and it has to survive the copy or the kernel would silently
    // let a per-context catalogue replace a static registration.
    const copy = registryWith(SEARCH_TOOL).copy();

    expect(() => copy.register(toolFor(SEARCH_TOOL))).toThrow(DuplicateRegistrationError);
    expect(copy.definitions()).toEqual([SEARCH_TOOL]);
  });

  it("isolates both directions, so neither registry sees the other's later tools", () => {
    // The kernel copies once per call and registers context-supplied tools onto
    // the copy. A host registry that grew a tool from someone else's call, or a
    // copy that kept growing after it was taken, would both be that isolation
    // failing.
    const source = registryWith(SEARCH_TOOL);
    const copy = source.copy();

    copy.register(toolFor(NOTION_TOOL));
    source.register(toolFor({ ...NOTION_TOOL, name: "notion.later" }));

    expect(copy.definitions().map(({ name }) => name)).toEqual(["files.search", "notion.search"]);
    expect(source.definitions().map(({ name }) => name)).toEqual(["files.search", "notion.later"]);
  });

  it("copies an empty registry", () => {
    expect(new ToolRegistry().copy().definitions()).toEqual([]);
  });
});
