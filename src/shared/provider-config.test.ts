import { describe, expect, it } from "vitest"

import { getComposerModelOptions, getDefaultComposerModelId } from "./provider-config"

describe("getComposerModelOptions", () => {
  it("matches the current Codex app model picker list", () => {
    expect(getComposerModelOptions("codex")).toEqual([
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
      { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max" },
      { id: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex-Mini" }
    ])
  })

  it("uses opus as the default Claude model", () => {
    expect(getDefaultComposerModelId("claude")).toBe("opus")
  })
})
