import { describe, expect, it } from "vitest"

import {
  detectCodeLanguage,
  mergeParsedPatchSummaries,
  parseApplyPatch,
  parseApplyPatches
} from "./patch"

describe("parseApplyPatch", () => {
  it("parses file summaries and counts from apply_patch blocks", () => {
    const parsed = parseApplyPatch([
      "*** Begin Patch",
      "*** Update File: src/demo.ts",
      "@@",
      "-const oldValue = 1",
      "+const nextValue = 2",
      " console.log(nextValue)",
      "*** Add File: src/new.tsx",
      "+export const Example = () => <div />",
      "*** End Patch"
    ].join("\n"))

    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]).toMatchObject({
      path: "src/demo.ts",
      operation: "update",
      additions: 1,
      deletions: 1
    })
    expect(parsed.files[1]).toMatchObject({
      path: "src/new.tsx",
      operation: "add",
      additions: 1,
      deletions: 0
    })
  })

  it("groups hunk lines with their add/remove/context type", () => {
    const parsed = parseApplyPatch([
      "*** Begin Patch",
      "*** Update File: src/demo.ts",
      "@@ render",
      " const value = 1",
      "-return value",
      "+return value + 1",
      "*** End Patch"
    ].join("\n"))

    expect(parsed.files[0]?.hunks[0]).toMatchObject({
      header: "render",
      lines: [
        { type: "context", content: "const value = 1" },
        { type: "remove", content: "return value" },
        { type: "add", content: "return value + 1" }
      ]
    })
  })
})

describe("detectCodeLanguage", () => {
  it("maps common file extensions to prism languages", () => {
    expect(detectCodeLanguage("src/example.tsx")).toBe("tsx")
    expect(detectCodeLanguage("src/example.ts")).toBe("typescript")
    expect(detectCodeLanguage("src/example.css")).toBe("css")
    expect(detectCodeLanguage("src/example.unknown")).toBe("plain")
  })
})

describe("parseApplyPatches", () => {
  it("aggregates multiple patch blocks into one summary", () => {
    const parsed = parseApplyPatches([
      [
        "*** Begin Patch",
        "*** Update File: src/demo.ts",
        "@@",
        "-const oldValue = 1",
        "+const nextValue = 2",
        "*** End Patch"
      ].join("\n"),
      [
        "*** Begin Patch",
        "*** Add File: src/new.tsx",
        "+export const Example = () => <div />",
        "*** End Patch"
      ].join("\n")
    ])

    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files.map(file => file.path)).toEqual(["src/demo.ts", "src/new.tsx"])
  })

  it("reassigns ids when merging parsed summaries", () => {
    const merged = mergeParsedPatchSummaries([
      parseApplyPatch([
        "*** Begin Patch",
        "*** Update File: src/demo.ts",
        "@@",
        "-const oldValue = 1",
        "+const nextValue = 2",
        "*** End Patch"
      ].join("\n")),
      parseApplyPatch([
        "*** Begin Patch",
        "*** Update File: src/demo-2.ts",
        "@@",
        "-const removedValue = 1",
        "+const addedValue = 2",
        "*** End Patch"
      ].join("\n"))
    ])

    expect(merged.files[0]?.id).toBe("file-1")
    expect(merged.files[1]?.id).toBe("file-2")
    expect(merged.files[0]?.hunks[0]?.id).toBe("file-1-hunk-1")
    expect(merged.files[1]?.hunks[0]?.id).toBe("file-2-hunk-1")
  })
})
