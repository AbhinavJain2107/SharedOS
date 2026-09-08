import type {
  AccessContext,
  JsonObject,
  ToolCall,
  ToolDefinition,
  ToolNamespaceCatalog,
  ToolResult,
} from "@aicoo/sharedos-contracts";
import { ToolDefinitionSchema } from "@aicoo/sharedos-contracts";

import type { AuthorizationRequest } from "./authorization.js";
import { DuplicateRegistrationError } from "./errors.js";
import { deepFreeze } from "./internal.js";

export interface ToolHandler {
  readonly definition: ToolDefinition;
  /** Parse and normalize untrusted arguments before authorization or execution. */
  readonly parseArguments: (arguments_: JsonObject) => unknown;
  /** Resolve argument-selected resources immediately before execution. */
  readonly resolveRequirement?: (context: AccessContext, call: ToolCall) => AuthorizationRequest;
  invoke(context: AccessContext, call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/**
 * Supplies tools for exactly one trusted access context.
 *
 * Hosts use this port for user-specific MCP servers and other dynamic catalogs
 * instead of mutating one global registry shared by concurrent users.
 */
export interface ContextToolProvider {
  readonly id: string;
  listTools(context: AccessContext, signal: AbortSignal): Promise<readonly ToolHandler[]>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    const parsedDefinition = ToolDefinitionSchema.safeParse(handler.definition);
    if (!parsedDefinition.success) {
      throw new TypeError("tool definition does not match the SharedOS contract");
    }

    const name = parsedDefinition.data.name;
    if (name.length === 0) {
      throw new TypeError("tool name must not be empty");
    }
    if (this.#tools.has(name)) {
      throw new DuplicateRegistrationError("tool", name);
    }

    const definition = deepFreeze(cloneDefinition(parsedDefinition.data));
    const parseArguments = handler.parseArguments;
    const resolveRequirement = handler.resolveRequirement;
    const invoke = handler.invoke;
    const registered: ToolHandler = {
      definition,
      parseArguments: (arguments_) => parseArguments(arguments_),
      invoke: (context, call, signal) => invoke(context, call, signal),
      ...(resolveRequirement === undefined
        ? {}
        : {
            resolveRequirement: (context: AccessContext, call: ToolCall) =>
              resolveRequirement(context, call),
          }),
    };

    // Frozen because `copy()` shares this object rather than rebuilding it.
    // Re-registering used to make every derived registry a fresh snapshot; a
    // shared mutable entry would instead let a swapped `definition` or `invoke`
    // reach back into the registry it was copied from.
    this.#tools.set(name, Object.freeze(registered));
  }

  /**
   * A registry holding the same registrations as this one.
   *
   * The entries are shared, not re-registered. Every one of them has already
   * been contract-validated, cloned and deep-frozen by {@link register}, which
   * also freezes the entry itself, so re-deriving one spends a schema parse and
   * a JSON round trip to arrive at a value equal to the one already held. That was
   * being paid on the path of every mediated call, where the kernel builds the
   * effective catalogue by re-registering its whole static registry.
   *
   * Copying keeps both properties the rebuild was relied on for: the copy
   * carries the names, so registering a colliding one still raises
   * {@link DuplicateRegistrationError}, and later registrations land on the
   * copy alone -- a host registry is never mutated by the call that adds
   * context-supplied tools beside it.
   */
  copy(): ToolRegistry {
    const copied = new ToolRegistry();
    for (const [name, handler] of this.#tools) {
      copied.#tools.set(name, handler);
    }
    return copied;
  }

  get(name: string): ToolHandler | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.#tools.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  handlers(): readonly ToolHandler[] {
    return [...this.#tools.values()].sort((left, right) =>
      left.definition.name.localeCompare(right.definition.name),
    );
  }

  namespaceCatalog(enabledToolNamespaces: readonly string[]): ToolNamespaceCatalog {
    const enabled = new Set(enabledToolNamespaces);
    const grouped = new Map<string, { sources: Set<string>; toolCount: number }>();

    for (const definition of this.definitions()) {
      const current = grouped.get(definition.namespace) ?? {
        sources: new Set<string>(),
        toolCount: 0,
      };
      current.sources.add(definition.source);
      current.toolCount += 1;
      grouped.set(definition.namespace, current);
    }

    const namespaces = [...grouped.entries()]
      .map(([namespace, value]) => ({
        namespace,
        sources: [...value.sources].sort(),
        toolCount: value.toolCount,
        enabled: enabled.has(namespace),
      }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace));

    return {
      namespaces,
      summary: {
        total: namespaces.length,
        enabled: namespaces.filter((namespace) => namespace.enabled).length,
        disabled: namespaces.filter((namespace) => !namespace.enabled).length,
      },
    };
  }
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return JSON.parse(JSON.stringify(definition)) as ToolDefinition;
}
