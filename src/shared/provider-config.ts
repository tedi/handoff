import type {
  SessionProvider,
  ThinkingLevel,
  ThreadLaunchMode
} from "./contracts"
import providerModels from "./provider-models.json"

export interface ProviderModelOption {
  id: string
  label: string
}

interface ProviderModelConfig {
  defaultModelId: string
  models: ProviderModelOption[]
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
    defaultModelId: (providerModels.codex as ProviderModelConfig).defaultModelId,
    models: (providerModels.codex as ProviderModelConfig).models
  },
  claude: {
    provider: "claude",
    label: "Claude Code",
    launchModes: ["cli"],
    defaultLaunchMode: "cli",
    supportsFastMode: false,
    defaultModelId: (providerModels.claude as ProviderModelConfig).defaultModelId,
    models: (providerModels.claude as ProviderModelConfig).models
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
