import type {
  ConversationTranscript,
  SessionIndexEntry,
  TranscriptOptions
} from "./contracts"

const PATCH_FILE_PATTERN = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const SCAFFOLD_USER_PREFIXES = [
  "# AGENTS.md instructions for ",
  "<environment_context>"
]

interface MessageRecord {
  role: "user" | "assistant"
  text: string
  timestamp: string
  turnId: string | null
  phase: string | null
}

interface PatchRecord {
  patch: string
  timestamp: string
  turnId: string | null
}

interface JsonRecord {
  type?: string
  timestamp?: string
  payload?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isScaffoldUserMessage(text: string) {
  const stripped = text.trimStart()
  return SCAFFOLD_USER_PREFIXES.some(prefix => stripped.startsWith(prefix))
}

function shouldIncludeAssistantPhase(
  phase: string | null,
  includeCommentary: boolean
) {
  if (includeCommentary) {
    return true
  }

  return phase !== "commentary"
}

function extractMessageText(payload: Record<string, unknown>) {
  const content = payload.content

  if (typeof content === "string") {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return typeof payload.text === "string" ? payload.text.trim() : ""
  }

  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item)) {
      continue
    }

    const type = item.type
    const text =
      type === "input_text" || type === "output_text"
        ? item.text
        : type === "text"
          ? (item.text ?? item.content)
          : null

    if (typeof text === "string" && text.trim()) {
      parts.push(text.trim())
    }
  }

  return parts.join("\n\n").trim()
}

function extractPatchFiles(patch: string) {
  return Array.from(patch.matchAll(PATCH_FILE_PATTERN), match => match[1] ?? "")
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) {
      return index
    }
  }

  return null
}

function attachPatchesToMessages(messages: MessageRecord[], patches: PatchRecord[]) {
  const attachments = new Map<number, PatchRecord[]>()

  for (const patch of patches) {
    const sameTurnAssistants = messages
      .map((message, index) => ({ index, message }))
      .filter(
        entry =>
          entry.message.role === "assistant" && entry.message.turnId === patch.turnId
      )

    if (sameTurnAssistants.length === 0) {
      continue
    }

    const futureFinalAnswer = sameTurnAssistants.find(
      entry =>
        entry.message.timestamp >= patch.timestamp &&
        entry.message.phase === "final_answer"
    )
    const futureAssistant = sameTurnAssistants.find(
      entry => entry.message.timestamp >= patch.timestamp
    )
    const targetIndex =
      futureFinalAnswer?.index ??
      futureAssistant?.index ??
      sameTurnAssistants.at(-1)?.index

    if (targetIndex === undefined) {
      continue
    }

    const existing = attachments.get(targetIndex) ?? []
    existing.push(patch)
    attachments.set(targetIndex, existing)
  }

  return attachments
}

function renderMarkdown(
  messages: MessageRecord[],
  patches: PatchRecord[],
  includeDiffs: boolean
) {
  const parts: string[] = ["# Transcript"]
  const attachments = includeDiffs
    ? attachPatchesToMessages(messages, patches)
    : new Map<number, PatchRecord[]>()

  messages.forEach((message, index) => {
    parts.push(`\n## ${message.role === "assistant" ? "Assistant" : "User"}`)
    parts.push(message.text)

    if (!includeDiffs) {
      return
    }

    const attached = attachments.get(index) ?? []
    if (attached.length === 0) {
      return
    }

    parts.push("\n### Diffs")
    attached.forEach((patch, patchIndex) => {
      const files = extractPatchFiles(patch.patch)
      parts.push(`\n#### Patch ${patchIndex + 1}`)
      parts.push(`Files: ${files.length > 0 ? files.join(", ") : "unknown files"}`)
      parts.push(`\n\`\`\`diff\n${patch.patch}\n\`\`\``)
    })
  })

  return `${parts.join("\n").trim()}\n`
}

function findLastAssistantMarkdown(messages: MessageRecord[]) {
  const finalAnswerIndex = findLastIndex(
    messages,
    message => message.role === "assistant" && message.phase === "final_answer"
  )
  if (finalAnswerIndex !== null) {
    return messages[finalAnswerIndex]?.text ?? null
  }

  const assistantIndex = findLastIndex(messages, message => message.role === "assistant")
  return assistantIndex !== null ? messages[assistantIndex]?.text ?? null : null
}

export function buildConversationTranscript(params: {
  sessionContent: string
  session: SessionIndexEntry
  sessionPath: string | null
  options: TranscriptOptions
}): ConversationTranscript {
  const { options, session, sessionContent, sessionPath } = params
  const messages: MessageRecord[] = []
  const patches: PatchRecord[] = []
  let currentTurnId: string | null = null

  const lines = sessionContent.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim()
    if (!line) {
      continue
    }

    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid JSON on line ${lineIndex + 1}: ${message}`)
    }

    const payload = isRecord(record.payload) ? record.payload : {}
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : ""

    if (record.type === "event_msg" && payload.type === "task_started") {
      currentTurnId =
        typeof payload.turn_id === "string" ? payload.turn_id : null
      continue
    }

    if (record.type !== "response_item") {
      continue
    }

    if (payload.type === "message") {
      const role =
        payload.role === "user" || payload.role === "assistant"
          ? payload.role
          : null
      if (!role) {
        continue
      }

      const text = extractMessageText(payload)
      if (!text) {
        continue
      }

      if (role === "user" && isScaffoldUserMessage(text)) {
        continue
      }

      const phase = typeof payload.phase === "string" ? payload.phase : null
      if (
        role === "assistant" &&
        !shouldIncludeAssistantPhase(phase, options.includeCommentary)
      ) {
        continue
      }

      messages.push({
        role,
        text,
        timestamp,
        turnId: currentTurnId,
        phase
      })
      continue
    }

    if (
      (payload.type === "custom_tool_call" || payload.type === "function_call") &&
      payload.name === "apply_patch"
    ) {
      const patchInput =
        typeof payload.input === "string"
          ? payload.input
          : typeof payload.arguments === "string"
            ? payload.arguments
            : ""

      if (!patchInput) {
        continue
      }

      patches.push({
        patch: patchInput,
        timestamp,
        turnId: currentTurnId
      })
    }
  }

  return {
    id: session.id,
    threadName: session.threadName,
    updatedAt: session.updatedAt,
    sessionPath,
    markdown: renderMarkdown(messages, patches, options.includeDiffs),
    lastAssistantMarkdown: findLastAssistantMarkdown(messages),
    hasDiffs: patches.length > 0
  }
}
