import type {
  AccessContext,
  JsonObject,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@aicoo/sharedos-contracts";
import { ToolDefinitionSchema } from "@aicoo/sharedos-contracts";
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
    // The kernel copies once per turn and registers context-supplied tools onto
    // the copy. A host registry that grew a tool from someone else's turn, or a
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

/**
 * What `register` stored before the walk: the whole definition through
 * `ToolDefinitionSchema`, then a JSON round trip.
 *
 * Kept here as the oracle, so the reading `register` does now is compared
 * against the one it replaced rather than described by the tests that assert
 * it.
 */
function registeredTheOldWay(definition: unknown): ToolDefinition | undefined {
  const parsed = ToolDefinitionSchema.safeParse(definition);
  return parsed.success ? (JSON.parse(JSON.stringify(parsed.data)) as ToolDefinition) : undefined;
}

/** Every own name at every depth, so a dropped or an added key is seen, not just a changed value. */
function shape(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.getOwnPropertyNames(value).map((key) => [
    key,
    shape((value as Record<string, unknown>)[key]),
  ]);
}

function registered(definition: unknown): ToolDefinition | undefined {
  const registry = new ToolRegistry();
  try {
    registry.register(toolFor(definition as ToolDefinition));
  } catch {
    return undefined;
  }
  return registry.get("files.search")?.definition;
}

describe("reading a tool definition's JSON blobs", () => {
  class Plain {
    readonly own = 1;
  }
  const inherited = Object.create({ inherited: "yes" }) as Record<string, unknown>;
  inherited["own"] = 1;
  const hidden = Object.defineProperty({ shown: 1 }, "hidden", { value: 2, enumerable: false });
  const getter = Object.defineProperty({}, "computed", { get: () => "read", enumerable: true });
  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays

  const blobs: readonly [string, unknown][] = [
    ["an ordinary JSON Schema", { type: "object", properties: { q: { type: "string" } } }],
    ["nested branches", { oneOf: [{ const: "a" }, { const: "b" }], items: [[{ x: null }]] }],
    ["an empty object", {}],
    ["a negative zero", { minimum: -0, nested: { z: -0 } }],
    ["a non-finite number", { maximum: Number.POSITIVE_INFINITY }],
    ["a nan", { maximum: Number.NaN }],
    ["an undefined field", { type: undefined }],
    ["an undefined field nested", { properties: { q: undefined } }],
    ["a bigint", { maximum: 1n }],
    ["a symbol", { type: Symbol("object") }],
    ["a function", { validate: () => true }],
    ["a date", { since: new Date(0) }],
    ["a map", { m: new Map() }],
    ["a set", { s: new Set() }],
    ["a thenable", { p: { then: () => 1, catch: () => 1 } }],
    ["a class instance", { o: new Plain() }],
    ["an inherited enumerable key", { o: inherited }],
    ["a null prototype", { o: nullProto }],
    ["a non-enumerable own key", { o: hidden }],
    ["an enumerable getter", { o: getter }],
    ["a typed array", { o: new Uint8Array([1, 2]) }],
    ["a sparse array", { enum: sparse }],
    ["an array holding undefined", { enum: [1, undefined] }],
    ["an own __proto__ key", JSON.parse('{"__proto__":{"x":1},"type":"object"}') as unknown],
    ["a deep value", JSON.parse(`{"a":${"[".repeat(64)}1${"]".repeat(64)}}`) as unknown],
    ["a frozen value", Object.freeze({ type: Object.freeze(["object"]) })],
    ["not an object at all", "object"],
    ["an array", [1, 2]],
    ["null", null],
    ["a number", 1],
  ];

  it.each(blobs)("gives the verdict the schema gave, as inputSchema: %s", (_label, blob) => {
    const definition = { ...SEARCH_TOOL, inputSchema: blob };

    const expected = registeredTheOldWay(definition);
    const actual = registered(definition);

    expect(actual === undefined).toBe(expected === undefined);
    expect(actual).toEqual(expected);
    expect(shape(actual)).toEqual(shape(expected));
  });

  it.each(blobs)("gives the verdict the schema gave, as outputSchema: %s", (_label, blob) => {
    // The optional fields matter more than the required one: a stand-in that
    // papered over them would let a definition the contract refuses through,
    // and it would do it silently, on the field nothing else reads.
    const definition = { ...SEARCH_TOOL, outputSchema: blob };

    const expected = registeredTheOldWay(definition);
    const actual = registered(definition);

    expect(actual === undefined).toBe(expected === undefined);
    expect(actual).toEqual(expected);
    expect(shape(actual)).toEqual(shape(expected));
  });

  it.each(blobs)("gives the verdict the schema gave, as metadata: %s", (_label, blob) => {
    const definition = { ...SEARCH_TOOL, metadata: blob };

    const expected = registeredTheOldWay(definition);
    const actual = registered(definition);

    expect(actual === undefined).toBe(expected === undefined);
    expect(actual).toEqual(expected);
    expect(shape(actual)).toEqual(shape(expected));
  });

  it("still refuses a definition with no inputSchema at all", () => {
    const { inputSchema: _dropped, ...withoutInputSchema } = SEARCH_TOOL;

    expect(registeredTheOldWay(withoutInputSchema)).toBeUndefined();
    expect(registered(withoutInputSchema)).toBeUndefined();
  });

  it("keeps an optional blob optional when the key is present and undefined", () => {
    const definition = { ...SEARCH_TOOL, outputSchema: undefined, metadata: undefined };

    const actual = registered(definition);

    expect(actual).toEqual(registeredTheOldWay(definition));
    expect(actual).toEqual(SEARCH_TOOL);
    expect("outputSchema" in (actual ?? {})).toBe(false);
  });

  it("reads a blob the definition inherits, because the schema reads one", () => {
    // `z.object` reads its shape by property access, so a definition whose
    // `inputSchema` sits on a prototype is accepted today. The walk is given
    // the same lookup rather than an own-key test, so it stays accepted.
    const definition = Object.create({
      inputSchema: { type: "object" },
    }) as Record<string, unknown>;
    Object.assign(definition, { ...SEARCH_TOOL, inputSchema: undefined });
    delete definition["inputSchema"];

    const actual = registered(definition);

    expect(actual).toEqual(registeredTheOldWay(definition));
    expect(actual?.inputSchema).toEqual({ type: "object" });
  });

  it("stores a copy, so a definition mutated after registration is not the one served", () => {
    const properties = { query: { type: "string" } };
    const definition = { ...SEARCH_TOOL, inputSchema: { type: "object", properties } };

    const registry = new ToolRegistry();
    registry.register(toolFor(definition));
    properties.query.type = "number";

    expect(registry.get("files.search")?.definition.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });

  it("freezes the blob at every depth, not just the definition", () => {
    const registry = registryWith({
      ...SEARCH_TOOL,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    });

    const stored = registry.get("files.search")?.definition;
    const properties = stored?.inputSchema["properties"] as Record<string, JsonObject>;

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.inputSchema)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(properties["query"])).toBe(true);
  });
});
