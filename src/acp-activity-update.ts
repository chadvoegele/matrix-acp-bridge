import { takeBytes } from "./bounded-text.js";
import { isRecord } from "./object-validation.js";

export type AcpSessionId = string;

export type AcpMessageId = string;

export type AcpIgnoredUpdateKind =
  | "user_message_chunk"
  | "plan"
  | "available_commands"
  | "current_mode_update"
  | "config_option_update"
  | "usage_update"
  | "unknown";

export interface AcpAgentMessageChunk {
  readonly sessionId: AcpSessionId;
  readonly kind: "agent_message_chunk";
  readonly text: string;
  readonly messageId?: AcpMessageId;
}

export interface AcpIgnoredUpdate {
  readonly sessionId: AcpSessionId;
  readonly kind: AcpIgnoredUpdateKind;
  readonly messageId?: AcpMessageId;
}

export interface AcpAgentThoughtChunk {
  readonly sessionId: AcpSessionId;
  readonly kind: "agent_thought_chunk";
  readonly text: string;
  readonly textCut?: boolean;
  readonly messageId?: AcpMessageId;
}

export type AcpToolContent =
  | { readonly type: "content"; readonly text: string }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText?: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

export type AcpToolInput =
  | string
  | number
  | boolean
  | null
  | readonly AcpToolInput[]
  | { readonly [key: string]: AcpToolInput };

export interface AcpToolCallUpdate {
  readonly sessionId: AcpSessionId;
  readonly kind: "tool_call" | "tool_call_update";
  readonly messageId?: AcpMessageId;
  readonly toolCallId?: string;
  readonly title?: string;
  readonly toolKind?: string;
  readonly status?: string;
  readonly content?: readonly AcpToolContent[];
  readonly contentCut?: boolean;
  readonly activityCut?: boolean;
  readonly locations?: readonly {
    readonly path: string;
    readonly line?: number;
  }[];
  readonly rawInput?: AcpToolInput;
  readonly rawOutput?: AcpToolInput;
  readonly terminalOutput?: {
    readonly terminalId?: string;
    readonly data: string;
    readonly originalBytes?: number;
  };
  readonly terminalExit?: {
    readonly terminalId?: string;
    readonly exitCode?: number;
    readonly signal?: string | null;
  };
}

export type AcpUpdate =
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCallUpdate
  | AcpIgnoredUpdate;

export type AcpUpdateListener = (update: AcpUpdate) => void;

/** Minimum notification envelope required before SDK dispatch. */
export function isAcpUpdateNotification(value: unknown): value is {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
} {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    isRecord(value.update) &&
    typeof value.update.sessionUpdate === "string"
  );
}

export const ACP_ACTIVITY_UPDATE_MAX_BYTES = 256 * 1024;

/** Shared retained-payload budget, not a wire-frame or rendering limit. */
class ActivityBudget {
  remaining = ACP_ACTIVITY_UPDATE_MAX_BYTES;

  cut = false;

  take(value: string): string {
    const bounded = takeBytes(value, this.remaining);
    this.remaining -= Buffer.byteLength(bounded.text, "utf8");
    this.cut ||= bounded.cut;
    return bounded.text;
  }
}

function boundedTerminalData(
  value: string,
  budget: ActivityBudget,
): { data: string; originalBytes?: number } {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= budget.remaining) return { data: budget.take(value) };
  const capacity = Math.max(0, budget.remaining - 2);
  const head = takeBytes(value, Math.floor(capacity * 0.75)).text;
  const tail = takeBytes(
    value,
    capacity - Buffer.byteLength(head, "utf8"),
    true,
  ).text;
  const data = budget.take(`${head}\n\n${tail}`);
  budget.cut = true;
  return { data, originalBytes };
}

function boundedString(
  value: unknown,
  budget: ActivityBudget,
): string | undefined {
  return typeof value === "string" ? budget.take(value) : undefined;
}

/** Copy JSON input within a shared budget; never retain the agent's raw object. */
function boundedInput(
  value: unknown,
  budget: ActivityBudget,
): AcpToolInput | undefined {
  const copy = (item: unknown, depth: number): AcpToolInput | undefined => {
    if (budget.remaining <= 0 || depth > 4) {
      budget.cut = true;
      return undefined;
    }
    if (typeof item === "string") return budget.take(item);
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes > budget.remaining) {
        budget.cut = true;
        return undefined;
      }
      budget.remaining -= bytes;
      return item;
    }
    if (Array.isArray(item)) {
      budget.remaining -= 1;
      budget.cut ||= item.length > 32;
      return item.slice(0, 32).flatMap((entry: unknown) => {
        const parsed = copy(entry, depth + 1);
        return parsed === undefined ? [] : [parsed];
      });
    }
    if (isRecord(item)) {
      budget.remaining -= 1;
      budget.cut ||= Object.keys(item).length > 32;
      const entries: Array<[string, AcpToolInput]> = [];
      for (const [key, entry] of Object.entries(item).slice(0, 32)) {
        if (budget.remaining <= 0) {
          budget.cut = true;
          break;
        }
        const boundedKey = takeBytes(key, 128);
        budget.cut ||= boundedKey.cut;
        const name = budget.take(boundedKey.text);
        const parsed = copy(entry, depth + 1);
        if (parsed !== undefined) entries.push([name, parsed]);
      }
      return Object.fromEntries(entries);
    }
    return undefined;
  };
  return value === undefined ? undefined : copy(value, 0);
}

function toolContent(
  value: unknown,
  budget: ActivityBudget,
): { content: readonly AcpToolContent[]; cut: boolean } | undefined {
  if (!Array.isArray(value)) return undefined;
  let cut = value.length > 32;
  const content = value
    .slice(0, 32)
    .flatMap((entry: unknown): AcpToolContent[] => {
      if (!isRecord(entry)) return [];
      if (
        entry.type === "content" &&
        isRecord(entry.content) &&
        entry.content.type === "text"
      ) {
        const text = boundedString(entry.content.text, budget);
        cut ||= budget.cut;
        return text === undefined ? [] : [{ type: "content", text }];
      }
      if (entry.type === "diff" && typeof entry.path === "string") {
        const path = boundedString(entry.path, budget)!;
        const oldText = boundedString(entry.oldText, budget);
        const newText = boundedString(entry.newText, budget);
        cut ||= budget.cut;
        const oldField =
          entry.oldText === null
            ? { oldText: null }
            : oldText === undefined
              ? {}
              : { oldText };
        return [
          {
            type: "diff",
            path,
            ...oldField,
            ...(newText === undefined ? {} : { newText }),
          },
        ];
      }
      if (entry.type === "terminal" && typeof entry.terminalId === "string") {
        return [
          {
            type: "terminal",
            terminalId: boundedString(entry.terminalId, budget)!,
          },
        ];
      }
      return [];
    });
  return { content, cut };
}

function toolLocations(
  value: unknown,
  budget: ActivityBudget,
): AcpToolCallUpdate["locations"] {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 32).flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.path === "string"
      ? [
          {
            path: boundedString(entry.path, budget)!,
            ...(typeof entry.line === "number" &&
            Number.isSafeInteger(entry.line) &&
            entry.line > 0
              ? { line: entry.line }
              : {}),
          },
        ]
      : [],
  );
}

function terminalMetadata(
  value: unknown,
  budget: ActivityBudget,
): Pick<AcpToolCallUpdate, "terminalOutput" | "terminalExit"> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  if (
    isRecord(value.terminal_output) &&
    typeof value.terminal_output.data === "string"
  ) {
    const terminalId = boundedString(value.terminal_output.terminal_id, budget);
    result.terminalOutput = {
      ...boundedTerminalData(value.terminal_output.data, budget),
      ...(terminalId === undefined ? {} : { terminalId }),
    };
  }
  if (isRecord(value.terminal_exit)) {
    const exit = value.terminal_exit;
    const terminalId = boundedString(exit.terminal_id, budget);
    const signal = boundedString(exit.signal, budget);
    const signalField =
      exit.signal === null
        ? { signal: null }
        : signal === undefined
          ? {}
          : { signal };
    result.terminalExit = {
      ...(terminalId === undefined ? {} : { terminalId }),
      ...(typeof exit.exit_code === "number" &&
      Number.isSafeInteger(exit.exit_code)
        ? { exitCode: exit.exit_code }
        : {}),
      ...signalField,
    };
  }
  return result;
}

function ignoredUpdateKind(value: string): AcpIgnoredUpdateKind {
  switch (value) {
    case "user_message_chunk": {
      return "user_message_chunk";
    }
    case "plan":
    case "plan_update":
    case "plan_removed": {
      return "plan";
    }
    case "available_commands_update": {
      return "available_commands";
    }
    case "current_mode_update": {
      return "current_mode_update";
    }
    case "config_option_update": {
      return "config_option_update";
    }
    case "usage_update": {
      return "usage_update";
    }
    default: {
      return "unknown";
    }
  }
}

/**
 * Normalize one notification without transport, turn, or renderer state.
 * Only thought/tool payloads use the shared activity budget; ordinary agent
 * messages and ignored updates retain their existing unbounded semantics.
 * Invalid envelopes or non-text message/thought chunks produce no update.
 */
export function normalizeAcpUpdateNotification(
  parameters: unknown,
): AcpUpdate | undefined {
  if (!isAcpUpdateNotification(parameters)) return undefined;
  const { sessionId, update } = parameters;
  const kind = update.sessionUpdate;
  const id =
    typeof update.messageId === "string" ? update.messageId : undefined;

  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = update.content;
    if (
      !isRecord(content) ||
      content.type !== "text" ||
      typeof content.text !== "string"
    )
      return undefined;
    if (kind === "agent_message_chunk") {
      return {
        sessionId,
        kind,
        text: content.text,
        ...(id === undefined ? {} : { messageId: id }),
      };
    }
    const budget = new ActivityBudget();
    const activityMessageId = boundedString(id, budget);
    const text = budget.take(content.text);
    return {
      sessionId,
      kind,
      text,
      ...(budget.cut ? { textCut: true } : {}),
      ...(activityMessageId === undefined
        ? {}
        : { messageId: activityMessageId }),
    };
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const budget = new ActivityBudget();
    const activityMessageId = boundedString(id, budget);
    const toolCallId = boundedString(update.toolCallId, budget);
    const toolKind = boundedString(update.kind, budget);
    const status = boundedString(update.status, budget);
    const title = boundedString(update.title, budget);
    const locations = toolLocations(update.locations, budget);
    const content = toolContent(update.content, budget);
    const terminal = terminalMetadata(update._meta, budget);
    const rawInput = boundedInput(update.rawInput, budget);
    const rawOutput = boundedInput(update.rawOutput, budget);
    return {
      sessionId,
      kind,
      ...(activityMessageId === undefined
        ? {}
        : { messageId: activityMessageId }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(title === undefined ? {} : { title }),
      ...(toolKind === undefined ? {} : { toolKind }),
      ...(status === undefined ? {} : { status }),
      ...(content === undefined
        ? {}
        : {
            content: content.content,
            ...(content.cut ? { contentCut: true } : {}),
          }),
      ...(locations === undefined ? {} : { locations }),
      ...(rawInput === undefined ? {} : { rawInput }),
      ...(rawOutput === undefined ? {} : { rawOutput }),
      ...terminal,
      ...(budget.cut ? { activityCut: true } : {}),
    };
  }

  return {
    sessionId,
    kind: ignoredUpdateKind(kind),
    ...(id === undefined ? {} : { messageId: id }),
  };
}
