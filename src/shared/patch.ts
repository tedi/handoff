export interface ParsedPatchLine {
  type: "context" | "add" | "remove"
  content: string
}

export interface ParsedPatchHunk {
  id: string
  header: string | null
  lines: ParsedPatchLine[]
}

export interface ParsedPatchFile {
  id: string
  path: string
  operation: "update" | "add" | "delete"
  additions: number
  deletions: number
  hunks: ParsedPatchHunk[]
}

export interface ParsedPatchSummary {
  additions: number
  deletions: number
  files: ParsedPatchFile[]
}

const FILE_HEADER_PATTERN = /^\*\*\* (Update|Add|Delete) File: (.+)$/
const HUNK_HEADER_PATTERN = /^@@(?: (.*))?$/

function createHunk(index: number, header: string | null): ParsedPatchHunk {
  return {
    id: `hunk-${index + 1}`,
    header,
    lines: []
  }
}

export function parseApplyPatch(patch: string): ParsedPatchSummary {
  const lines = patch.split(/\r?\n/)
  const files: ParsedPatchFile[] = []
  let currentFile: ParsedPatchFile | null = null
  let currentHunk: ParsedPatchHunk | null = null
  let currentHunkCount = 0

  function pushCurrentHunk() {
    if (!currentFile || !currentHunk) {
      return
    }

    if (currentHunk.lines.length > 0 || currentHunk.header) {
      currentFile.hunks.push(currentHunk)
    }

    currentHunk = null
  }

  function pushCurrentFile() {
    if (!currentFile) {
      return
    }

    pushCurrentHunk()
    files.push(currentFile)
    currentFile = null
    currentHunkCount = 0
  }

  function ensureHunk() {
    if (!currentHunk) {
      currentHunk = createHunk(currentHunkCount, null)
      currentHunkCount += 1
    }

    return currentHunk
  }

  for (const line of lines) {
    if (
      !line ||
      line === "*** Begin Patch" ||
      line === "*** End Patch" ||
      line === "*** End of File"
    ) {
      continue
    }

    const fileMatch = line.match(FILE_HEADER_PATTERN)
    if (fileMatch) {
      pushCurrentFile()
      const operation = fileMatch[1]!.toLowerCase() as ParsedPatchFile["operation"]
      currentFile = {
        id: `file-${files.length + 1}`,
        path: fileMatch[2]!,
        operation,
        additions: 0,
        deletions: 0,
        hunks: []
      }
      continue
    }

    if (!currentFile || line.startsWith("*** Move to: ")) {
      continue
    }

    const hunkMatch = line.match(HUNK_HEADER_PATTERN)
    if (hunkMatch) {
      pushCurrentHunk()
      currentHunk = createHunk(currentHunkCount, hunkMatch[1] ?? null)
      currentHunkCount += 1
      continue
    }

    const prefix = line[0]
    if (prefix !== " " && prefix !== "+" && prefix !== "-") {
      continue
    }

    const hunk = ensureHunk()
    hunk.lines.push({
      type: prefix === "+" ? "add" : prefix === "-" ? "remove" : "context",
      content: line.slice(1)
    })

    if (prefix === "+") {
      currentFile.additions += 1
    } else if (prefix === "-") {
      currentFile.deletions += 1
    }
  }

  pushCurrentFile()

  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files
  }
}

export function mergeParsedPatchSummaries(summaries: ParsedPatchSummary[]): ParsedPatchSummary {
  const files: ParsedPatchFile[] = []

  for (const summary of summaries) {
    for (const file of summary.files) {
      const fileId = `file-${files.length + 1}`

      files.push({
        ...file,
        id: fileId,
        hunks: file.hunks.map((hunk, index) => ({
          ...hunk,
          id: `${fileId}-hunk-${index + 1}`
        }))
      })
    }
  }

  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files
  }
}

export function parseApplyPatches(patches: string[]) {
  return mergeParsedPatchSummaries(patches.map(parseApplyPatch))
}

export function detectCodeLanguage(filePath: string) {
  const normalizedPath = filePath.toLowerCase()

  if (normalizedPath.endsWith(".tsx")) return "tsx"
  if (normalizedPath.endsWith(".ts")) return "typescript"
  if (normalizedPath.endsWith(".jsx")) return "jsx"
  if (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".mjs")) {
    return "javascript"
  }
  if (normalizedPath.endsWith(".json")) return "json"
  if (normalizedPath.endsWith(".css")) return "css"
  if (normalizedPath.endsWith(".md")) return "markdown"
  if (normalizedPath.endsWith(".html")) return "markup"
  if (normalizedPath.endsWith(".sh")) return "bash"

  return "plain"
}
