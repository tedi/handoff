import type {
  SessionProvider,
  ThinkingLevel,
  ThreadLaunchMode
} from "./contracts"

export interface ProviderModelOption {
  id: string
  label: string
}

export interface ComposerProviderConfig {
  provider: SessionProvider
  label: string
  launchModes: ThreadLaunchMode[]
  defaultLaunchMode: ThreadLaunchMode
  supportsFastMode: boolean
  defaultModelId: string
  models: ProviderModelOption[]
}

export const THINKING_LEVEL_OPTIONS: Array<{
  value: ThinkingLevel
  label: string
}> = [
  { value: "max", label: "Extra High" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" }
]

export const COMPOSER_PROVIDER_CONFIG: Record<SessionProvider, ComposerProviderConfig> = {
  codex: {
    provider: "codex",
    label: "Codex",
    launchModes: ["cli", "app"],
    defaultLaunchMode: "cli",
    supportsFastMode: true,
    defaultModelId: "gpt-5.4",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5-codex", label: "GPT-5-Codex" },
      { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
      { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
      { id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex Max" },
      { id: "gpt-5.1-codex", label: "GPT-5.1-Codex" },
      { id: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex Mini" },
      { id: "codex-mini-latest", label: "Codex Mini Latest" }
    ]
  },
  claude: {
    provider: "claude",
    label: "Claude Code",
    launchModes: ["cli"],
    defaultLaunchMode: "cli",
    supportsFastMode: false,
    defaultModelId: "sonnet",
    models: [
      { id: "default", label: "Default" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
      { id: "sonnet[1m]", label: "Sonnet (1M)" },
      { id: "opusplan", label: "Opus Plan" }
    ]
  }
}

export function getComposerProviderConfig(provider: SessionProvider) {
  return COMPOSER_PROVIDER_CONFIG[provider]
}

export function getComposerModelOptions(provider: SessionProvider) {
  return COMPOSER_PROVIDER_CONFIG[provider].models
}

export function getComposerModelLabel(provider: SessionProvider, modelId: string) {
  return (
    COMPOSER_PROVIDER_CONFIG[provider].models.find(model => model.id === modelId)?.label ??
    modelId
  )
}

export function getDefaultComposerModelId(provider: SessionProvider) {
  return COMPOSER_PROVIDER_CONFIG[provider].defaultModelId
}

export function getDefaultComposerLaunchMode(provider: SessionProvider) {
  return COMPOSER_PROVIDER_CONFIG[provider].defaultLaunchMode
}

export function isComposerLaunchModeSupported(
  provider: SessionProvider,
  launchMode: ThreadLaunchMode
) {
  return COMPOSER_PROVIDER_CONFIG[provider].launchModes.includes(launchMode)
}

export function normalizeComposerTarget(params: {
  provider: SessionProvider
  launchMode: ThreadLaunchMode
  modelId: string
  fast: boolean
}) {
  const config = COMPOSER_PROVIDER_CONFIG[params.provider]
  const launchMode = config.launchModes.includes(params.launchMode)
    ? params.launchMode
    : config.defaultLaunchMode
  const modelId = config.models.some(model => model.id === params.modelId)
    ? params.modelId
    : config.defaultModelId

  return {
    launchMode,
    modelId,
    fast: config.supportsFastMode ? params.fast : false
  }
}
