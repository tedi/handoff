import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"
import type {
  SelectorExportEstimateResult,
  SelectorExportResult,
  SelectorFileRecord,
  SelectorGitDiffMode,
  SelectorManifestSummary
} from "selector"

import type {
  RootListItem,
  SelectorAppStateInfo
} from "../shared/contracts"

const SEARCH_DEBOUNCE_MS = 160
const SEARCH_MIN_QUERY_LENGTH = 2
const SEARCH_RESULT_LIMIT = 80
const GIT_DIFF_MODE_OFF: SelectorGitDiffMode = "off"
const GIT_DIFF_MODE_DIFF_ONLY: SelectorGitDiffMode = "diff_only"
const GIT_DIFF_MODE_FULL_FILE_PLUS_DIFF: SelectorGitDiffMode = "full_file_plus_diff"

type ExportCopyResult = Awaited<
  ReturnType<typeof window.handoffApp.selector.exports.regenerateAndCopy>
>
type GitDiffStatsResult = Awaited<
  ReturnType<typeof window.handoffApp.selector.git.diffStats>
>
type GitStatusResult = Awaited<
  ReturnType<typeof window.handoffApp.selector.git.status>
>

type BundleDialogState =
  | {
      kind: "rename"
      manifestName: string
      value: string
    }
  | {
      kind: "duplicate"
      manifestName: string
      value: string
    }
  | {
      kind: "delete"
      manifestName: string
    }

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value))
}

function buildManifestMeta(manifest: SelectorManifestSummary) {
  return `${manifest.file_count} file${manifest.file_count === 1 ? "" : "s"}`
}

function buildTrackedFilesByPath(manifest: SelectorManifestSummary | null) {
  return new Map(manifest?.files.map(file => [file.path, file]) ?? [])
}

function renderExportSummary(result: SelectorExportResult | null) {
  if (!result) {
    return "Ready to regenerate the current manifest export."
  }

  return `${result.file_count} exported, ${result.estimated_tokens.toLocaleString()} estimated tokens`
}

function formatEstimatedTokens(result: SelectorExportEstimateResult | null) {
  if (!result) {
    return "Estimate unavailable"
  }

  return `${result.estimated_tokens.toLocaleString()} estimated tokens`
}

function getFileName(relativePath: string) {
  return relativePath.split("/").at(-1) ?? relativePath
}

function normalizeGitDiffMode(
  value: SelectorGitDiffMode | boolean | undefined,
  fallback: SelectorGitDiffMode = GIT_DIFF_MODE_OFF
) {
  if (value === true) {
    return GIT_DIFF_MODE_DIFF_ONLY
  }

  if (value === false) {
    return GIT_DIFF_MODE_OFF
  }

  if (
    value === GIT_DIFF_MODE_OFF ||
    value === GIT_DIFF_MODE_DIFF_ONLY ||
    value === GIT_DIFF_MODE_FULL_FILE_PLUS_DIFF
  ) {
    return value
  }

  return fallback
}

function resolveManifestGitDiffMode(manifest: SelectorManifestSummary | null) {
  return normalizeGitDiffMode(
    manifest?.git_diff_mode,
    manifest?.use_git_diffs === true ? GIT_DIFF_MODE_DIFF_ONLY : GIT_DIFF_MODE_OFF
  )
}

function isModifiedOrNewStatus(value: GitStatusResult[string] | null | undefined) {
  return value?.kind === "modified" || value?.kind === "new"
}

function hasGitDiffStat(value: GitDiffStatsResult[string] | null | undefined) {
  return (value?.added_lines ?? 0) > 0 || (value?.removed_lines ?? 0) > 0
}

function matchesBundleFilter(
  file: SelectorManifestSummary["files"][number],
  query: string
) {
  if (!query) {
    return true
  }

  const haystack = `${file.relative_path}\n${file.path}\n${file.comment ?? ""}`.toLowerCase()
  return haystack.includes(query)
}

function sortManifestSummaries<T extends { name: string; updated_at: string }>(
  manifests: T[]
) {
  return [...manifests].sort((left, right) => {
    const updatedDelta = right.updated_at.localeCompare(left.updated_at)

    if (updatedDelta !== 0) {
      return updatedDelta
    }

    return left.name.localeCompare(right.name)
  })
}

function upsertManifestSummary<T extends { name: string; updated_at: string }>(
  current: T[],
  next: T
) {
  return sortManifestSummaries([
    next,
    ...current.filter(manifest => manifest.name !== next.name)
  ])
}

function mergeManifestSummaries(
  manifests: SelectorManifestSummary[],
  nextManifest: SelectorManifestSummary,
  previousName = nextManifest.name
) {
  return upsertManifestSummary(
    manifests.filter(manifest => manifest.name !== previousName),
    nextManifest
  )
}

function SectionEmptyState({
  title,
  detail
}: {
  title: string
  detail: string
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  )
}

function NoteIcon() {
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 16 16">
      <path
        d="M4 2.75h8A1.25 1.25 0 0 1 13.25 4v8A1.25 1.25 0 0 1 12 13.25H4A1.25 1.25 0 0 1 2.75 12V4A1.25 1.25 0 0 1 4 2.75Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M5.5 6h5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 8.5h5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 11h3.25" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`icon chevron-icon ${expanded ? "is-expanded" : ""}`}
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M5.25 6.5 8 9.25l2.75-2.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 16 16">
      <path d="M3.75 4.5h8.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M6.25 2.75h3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path
        d="M5 4.5v7a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M6.75 6.5v4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.25 6.5v4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function EllipsisIcon() {
  return (
    <svg aria-hidden="true" className="icon" fill="currentColor" viewBox="0 0 16 16">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  )
}

export function useSelectorSection(params: {
  showToast(message: string, tone?: "success" | "error"): void
}) {
  const [stateInfo, setStateInfo] = useState<SelectorAppStateInfo | null>(null)
  const [roots, setRoots] = useState<RootListItem[]>([])
  const [manifests, setManifests] = useState<SelectorManifestSummary[]>([])
  const [activeManifestName, setActiveManifestName] = useState<string | null>(null)
  const [activeManifest, setActiveManifest] = useState<SelectorManifestSummary | null>(null)
  const [selectedRootId, setSelectedRootId] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(searchQuery.trim())
  const [bundleFilterQuery, setBundleFilterQuery] = useState("")
  const deferredBundleFilterQuery = useDeferredValue(bundleFilterQuery.trim().toLowerCase())
  const [searchResults, setSearchResults] = useState<SelectorFileRecord[]>([])
  const [estimateResult, setEstimateResult] = useState<SelectorExportEstimateResult | null>(null)
  const [exportResult, setExportResult] = useState<ExportCopyResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isOverviewLoading, setIsOverviewLoading] = useState(true)
  const [isManifestLoading, setIsManifestLoading] = useState(false)
  const [isEstimating, setIsEstimating] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isBundleMutating, setIsBundleMutating] = useState(false)
  const [isSavingExportSettings, setIsSavingExportSettings] = useState(false)
  const [mutatingPaths, setMutatingPaths] = useState<string[]>([])
  const [expandedPaths, setExpandedPaths] = useState<string[]>([])
  const [editingNotePath, setEditingNotePath] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState("")
  const [openManifestMenuName, setOpenManifestMenuName] = useState<string | null>(null)
  const [bundleDialog, setBundleDialog] = useState<BundleDialogState | null>(null)
  const [exportPrefixDraft, setExportPrefixDraft] = useState("")
  const [exportSuffixDraft, setExportSuffixDraft] = useState("")
  const [stripCommentsDraft, setStripCommentsDraft] = useState(false)
  const [gitDiffModeDraft, setGitDiffModeDraft] =
    useState<SelectorGitDiffMode>(GIT_DIFF_MODE_OFF)
  const [gitDiffStatsByPath, setGitDiffStatsByPath] = useState<GitDiffStatsResult>({})
  const [gitStatusByPath, setGitStatusByPath] = useState<GitStatusResult>({})
  const [isApplyingChangedSelection, setIsApplyingChangedSelection] = useState(false)
  const [isAddFilesModalOpen, setIsAddFilesModalOpen] = useState(false)
  const searchRequestIdRef = useRef(0)
  const estimateRequestIdRef = useRef(0)
  const gitDiffRequestIdRef = useRef(0)
  const addFilesInputRef = useRef<HTMLInputElement | null>(null)
  const bundleDialogInputRef = useRef<HTMLInputElement | null>(null)

  const trackedFilesByPath = useMemo(
    () => buildTrackedFilesByPath(activeManifest),
    [activeManifest]
  )
  const hasSearchQuery = deferredSearchQuery.length >= SEARCH_MIN_QUERY_LENGTH
  const useGitDiffsDraft = gitDiffModeDraft !== GIT_DIFF_MODE_OFF
  const includeFullFileWithDiffsDraft =
    gitDiffModeDraft === GIT_DIFF_MODE_FULL_FILE_PLUS_DIFF
  const modifiedOrNewPaths = useMemo(
    () =>
      activeManifest?.files
        .filter(file => {
          const gitStatus = gitStatusByPath[file.path]
          const gitDiffStat = gitDiffStatsByPath[file.path]

          return isModifiedOrNewStatus(gitStatus) || hasGitDiffStat(gitDiffStat)
        })
        .map(file => file.path) ?? [],
    [activeManifest, gitDiffStatsByPath, gitStatusByPath]
  )
  const modifiedOrNewPathSet = useMemo(
    () => new Set(modifiedOrNewPaths),
    [modifiedOrNewPaths]
  )
  const isModifiedOrNewOnlySelected = Boolean(
    activeManifest &&
      modifiedOrNewPaths.length > 0 &&
      activeManifest.files.every(file =>
        modifiedOrNewPathSet.has(file.path)
          ? file.selected !== false
          : file.selected === false
      )
  )
  const filteredManifestFiles = useMemo(
    () =>
      activeManifest?.files.filter(file =>
        matchesBundleFilter(file, deferredBundleFilterQuery)
      ) ?? [],
    [activeManifest, deferredBundleFilterQuery]
  )
  const hasUnsavedExportSettings = Boolean(
    activeManifest &&
      (exportPrefixDraft !== (activeManifest.export_prefix_text ?? "") ||
        exportSuffixDraft !== (activeManifest.export_suffix_text ?? "") ||
        stripCommentsDraft !== activeManifest.strip_comments ||
        gitDiffModeDraft !== resolveManifestGitDiffMode(activeManifest))
  )

  const loadOverview = useCallback(async () => {
    const api = window.handoffApp?.selector
    if (!api) {
      setErrorMessage("The preload bridge did not load. Restart the app.")
      setIsOverviewLoading(false)
      return
    }

    setIsOverviewLoading(true)

    try {
      const [nextStateInfo, nextRoots, nextManifests] = await Promise.all([
        api.app.getStateInfo(),
        api.roots.list(),
        api.manifests.list()
      ])

      setStateInfo(nextStateInfo)
      setRoots(nextRoots)
      setManifests(nextManifests)
      setActiveManifestName(current => {
        if (current && nextManifests.some(manifest => manifest.name === current)) {
          return current
        }

        return nextManifests[0]?.name ?? null
      })
      setSelectedRootId(current => {
        if (current && nextRoots.some(root => root.id === current)) {
          return current
        }

        return nextRoots[0]?.id ?? ""
      })
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsOverviewLoading(false)
    }
  }, [])

  const loadManifest = useCallback(async (manifestName: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      setErrorMessage("The preload bridge did not load. Restart the app.")
      setIsManifestLoading(false)
      return
    }

    setIsManifestLoading(true)

    try {
      const manifest = await api.manifests.get(manifestName)
      setActiveManifest(manifest)
      setExpandedPaths(current => current.filter(filePath => manifest.files.some(file => file.path === filePath)))
      setManifests(current => upsertManifestSummary(current, manifest))
      setErrorMessage(null)
    } catch (error) {
      setActiveManifest(null)
      setEstimateResult(null)
      setExportResult(null)
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setIsManifestLoading(false)
    }
  }, [])

  const runSearch = useCallback(async (rootId: string, query: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      setErrorMessage("The preload bridge did not load. Restart the app.")
      setIsSearching(false)
      return
    }

    const requestId = ++searchRequestIdRef.current
    setIsSearching(true)

    try {
      const result = await api.files.search(rootId, query, SEARCH_RESULT_LIMIT)
      if (searchRequestIdRef.current !== requestId) {
        return
      }

      setSearchResults(result.files)
      setErrorMessage(null)
    } catch (error) {
      if (searchRequestIdRef.current !== requestId) {
        return
      }

      setSearchResults([])
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setIsSearching(false)
      }
    }
  }, [])

  const loadEstimate = useCallback(async (manifestName: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      setErrorMessage("The preload bridge did not load. Restart the app.")
      setIsEstimating(false)
      return
    }

    const requestId = ++estimateRequestIdRef.current
    setIsEstimating(true)

    try {
      const result = await api.exports.estimate(manifestName)
      if (estimateRequestIdRef.current !== requestId) {
        return
      }

      setEstimateResult(result)
      setErrorMessage(null)
    } catch (error) {
      if (estimateRequestIdRef.current !== requestId) {
        return
      }

      setEstimateResult(null)
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (estimateRequestIdRef.current === requestId) {
        setIsEstimating(false)
      }
    }
  }, [])

  const loadGitMetadata = useCallback(async (manifest: SelectorManifestSummary | null) => {
    const api = window.handoffApp?.selector
    if (!api) {
      setGitDiffStatsByPath({})
      setGitStatusByPath({})
      return
    }

    const requestId = ++gitDiffRequestIdRef.current

    if (!manifest || manifest.files.length === 0) {
      setGitDiffStatsByPath({})
      setGitStatusByPath({})
      return
    }

    const filePaths = manifest.files.map(file => file.path)
    const [statsResult, statusesResult] = await Promise.allSettled([
      api.git.diffStats(filePaths),
      api.git.status(filePaths)
    ])

    if (gitDiffRequestIdRef.current !== requestId) {
      return
    }

    setGitDiffStatsByPath(statsResult.status === "fulfilled" ? statsResult.value : {})
    setGitStatusByPath(statusesResult.status === "fulfilled" ? statusesResult.value : {})
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    if (!activeManifestName) {
      setActiveManifest(null)
      setEstimateResult(null)
      setExportResult(null)
      return
    }

    void loadManifest(activeManifestName)
  }, [activeManifestName, loadManifest])

  useEffect(() => {
    setExportPrefixDraft(activeManifest?.export_prefix_text ?? "")
    setExportSuffixDraft(activeManifest?.export_suffix_text ?? "")
    setStripCommentsDraft(activeManifest?.strip_comments ?? false)
    setGitDiffModeDraft(resolveManifestGitDiffMode(activeManifest))
  }, [activeManifest])

  useEffect(() => {
    if (editingNotePath && !activeManifest?.files.some(file => file.path === editingNotePath)) {
      setEditingNotePath(null)
      setNoteDraft("")
    }
  }, [activeManifest, editingNotePath])

  useEffect(() => {
    if (!activeManifest) {
      estimateRequestIdRef.current += 1
      gitDiffRequestIdRef.current += 1
      setEstimateResult(null)
      setGitDiffStatsByPath({})
      setGitStatusByPath({})
      setIsEstimating(false)
      return
    }

    const timeoutId = window.setTimeout(() => {
      void loadEstimate(activeManifest.name)
    }, 120)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [activeManifest, loadEstimate])

  useEffect(() => {
    void loadGitMetadata(activeManifest)
  }, [activeManifest, loadGitMetadata])

  useEffect(() => {
    if (!isAddFilesModalOpen || !activeManifestName || !selectedRootId || !hasSearchQuery) {
      searchRequestIdRef.current += 1
      setSearchResults([])
      setIsSearching(false)
      return
    }

    const timeoutId = window.setTimeout(() => {
      void runSearch(selectedRootId, deferredSearchQuery)
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    activeManifestName,
    deferredSearchQuery,
    hasSearchQuery,
    isAddFilesModalOpen,
    runSearch,
    selectedRootId
  ])

  useEffect(() => {
    if (!activeManifest) {
      setIsAddFilesModalOpen(false)
      return
    }

    if (!isAddFilesModalOpen) {
      return
    }

    addFilesInputRef.current?.focus()
  }, [activeManifest, isAddFilesModalOpen])

  useEffect(() => {
    if (!isAddFilesModalOpen) {
      return
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsAddFilesModalOpen(false)
      }
    }

    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("keydown", handleEscape)
    }
  }, [isAddFilesModalOpen])

  useEffect(() => {
    if (!bundleDialog || bundleDialog.kind === "delete") {
      return
    }

    bundleDialogInputRef.current?.focus()
    bundleDialogInputRef.current?.select()
  }, [bundleDialog])

  useEffect(() => {
    if (!openManifestMenuName) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target

      if (target instanceof Element && target.closest("[data-selector-manifest-menu]")) {
        return
      }

      setOpenManifestMenuName(null)
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenManifestMenuName(null)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleEscape)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleEscape)
    }
  }, [openManifestMenuName])

  useEffect(() => {
    if (!bundleDialog) {
      return
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setBundleDialog(null)
      }
    }

    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("keydown", handleEscape)
    }
  }, [bundleDialog])

  const handleStateChanged = useCallback(async () => {
    await loadOverview()

    if (activeManifestName) {
      await loadManifest(activeManifestName)
    }

    if (isAddFilesModalOpen && selectedRootId && hasSearchQuery) {
      await runSearch(selectedRootId, deferredSearchQuery)
    }
  }, [
    activeManifestName,
    deferredSearchQuery,
    hasSearchQuery,
    isAddFilesModalOpen,
    loadManifest,
    loadOverview,
    runSearch,
    selectedRootId
  ])

  useEffect(() => {
    const api = window.handoffApp?.selector
    if (!api) {
      return () => undefined
    }

    return api.app.onStateChanged(() => {
      void handleStateChanged()
    })
  }, [handleStateChanged])

  const openPathInEditor = useCallback(
    async (targetPath: string) => {
      const api = window.handoffApp?.selector
      if (!api) {
        params.showToast("The preload bridge did not load. Restart the app.", "error")
        return
      }

      try {
        await api.app.openPath(targetPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setErrorMessage(message)
        params.showToast(message, "error")
      }
    },
    [params]
  )

  const toggleExpandedPath = useCallback((filePath: string) => {
    setExpandedPaths(current =>
      current.includes(filePath)
        ? current.filter(pathEntry => pathEntry !== filePath)
        : [...current, filePath]
    )
  }, [])

  const addManifestFile = useCallback(async (filePath: string) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    const wasTracked = trackedFilesByPath.has(filePath)
    setMutatingPaths(current => [...current, filePath])

    try {
      const nextManifest = await api.manifests.addFiles(activeManifest.name, [filePath])
      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      setErrorMessage(null)
      params.showToast(wasTracked ? "Manifest updated: file selected" : "Manifest updated: file added")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setMutatingPaths(current => current.filter(entry => entry !== filePath))
    }
  }, [activeManifest, params, trackedFilesByPath])

  const setManifestFileSelected = useCallback(async (filePath: string, selected: boolean) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setMutatingPaths(current => [...current, filePath])

    try {
      const nextManifest = await api.manifests.setSelected(
        activeManifest.name,
        filePath,
        selected
      )

      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      setErrorMessage(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setMutatingPaths(current => current.filter(entry => entry !== filePath))
    }
  }, [activeManifest, params])

  const removeManifestFile = useCallback(async (filePath: string) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setMutatingPaths(current => [...current, filePath])

    try {
      const nextManifest = await api.manifests.removeFiles(activeManifest.name, [filePath])
      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      setExpandedPaths(current => current.filter(pathEntry => pathEntry !== filePath))
      setErrorMessage(null)
      params.showToast("Removed file from manifest")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setMutatingPaths(current => current.filter(entry => entry !== filePath))
    }
  }, [activeManifest, params])

  const setChangedSelectionOnly = useCallback(async (checked: boolean) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setIsApplyingChangedSelection(true)

    try {
      const nextPaths = checked
        ? modifiedOrNewPaths
        : activeManifest.files.map(file => file.path)

      const nextManifest =
        typeof api.manifests.setSelectedPaths === "function"
          ? await api.manifests.setSelectedPaths(activeManifest.name, nextPaths)
          : await activeManifest.files.reduce(async (pendingManifestPromise, file) => {
              const currentManifest = await pendingManifestPromise
              return api.manifests.setSelected(
                currentManifest.name,
                file.path,
                nextPaths.includes(file.path)
              )
            }, Promise.resolve(activeManifest))

      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      setErrorMessage(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsApplyingChangedSelection(false)
    }
  }, [activeManifest, modifiedOrNewPaths, params])

  const beginEditingNote = useCallback((filePath: string, currentComment: string | null) => {
    setEditingNotePath(filePath)
    setNoteDraft(currentComment ?? "")
  }, [])

  const closeNoteEditor = useCallback(() => {
    setEditingNotePath(null)
    setNoteDraft("")
  }, [])

  const saveManifestComment = useCallback(async (filePath: string) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setMutatingPaths(current => [...current, filePath])

    try {
      const nextManifest = await api.manifests.setComment(activeManifest.name, filePath, noteDraft)
      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      closeNoteEditor()
      setErrorMessage(null)
      params.showToast("Saved file note")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setMutatingPaths(current => current.filter(entry => entry !== filePath))
    }
  }, [activeManifest, closeNoteEditor, noteDraft, params])

  const saveExportSettings = useCallback(async (
    showSuccessToast = true,
    overrides?: {
      stripComments?: boolean
      gitDiffMode?: SelectorGitDiffMode
    }
  ) => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setIsSavingExportSettings(true)

    try {
      const nextManifest = await api.manifests.setExportText(
        activeManifest.name,
        exportPrefixDraft,
        exportSuffixDraft,
        overrides?.stripComments ?? stripCommentsDraft,
        overrides?.gitDiffMode ?? gitDiffModeDraft
      )

      setActiveManifest(nextManifest)
      setManifests(current => mergeManifestSummaries(current, nextManifest))
      setErrorMessage(null)

      if (showSuccessToast) {
        params.showToast("Saved export settings")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsSavingExportSettings(false)
    }
  }, [
    activeManifest,
    exportPrefixDraft,
    exportSuffixDraft,
    gitDiffModeDraft,
    params,
    stripCommentsDraft
  ])

  const resolveManifestForAction = useCallback(async (manifestName: string) => {
    if (activeManifest?.name === manifestName) {
      return activeManifest
    }

    return manifests.find(manifest => manifest.name === manifestName) ?? null
  }, [activeManifest, manifests])

  const renameManifest = useCallback(async (manifestName: string, nextName: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      return
    }

    setIsBundleMutating(true)

    try {
      const manifestForAction = await resolveManifestForAction(manifestName)
      const trimmedName = nextName.trim()

      if (!manifestForAction || trimmedName === manifestForAction.name) {
        setBundleDialog(null)
        return
      }

      const nextManifest = await api.manifests.rename(manifestForAction.name, trimmedName)
      setManifests(current =>
        mergeManifestSummaries(current, nextManifest, manifestForAction.name)
      )
      setActiveManifestName(nextManifest.name)
      setBundleDialog(null)
      setOpenManifestMenuName(null)
      setErrorMessage(null)
      params.showToast("Bundle renamed")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsBundleMutating(false)
    }
  }, [params, resolveManifestForAction])

  const duplicateManifest = useCallback(async (manifestName: string, nextName: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      return
    }

    setIsBundleMutating(true)

    try {
      const manifestForAction = await resolveManifestForAction(manifestName)
      const trimmedName = nextName.trim()

      if (!manifestForAction) {
        return
      }

      const nextManifest = await api.manifests.duplicate(manifestForAction.name, trimmedName)
      setManifests(current => upsertManifestSummary(current, nextManifest))
      setActiveManifestName(nextManifest.name)
      setBundleDialog(null)
      setOpenManifestMenuName(null)
      setErrorMessage(null)
      params.showToast("Bundle duplicated")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsBundleMutating(false)
    }
  }, [params, resolveManifestForAction])

  const deleteBundle = useCallback(async (manifestName: string) => {
    const api = window.handoffApp?.selector
    if (!api) {
      return
    }

    setIsBundleMutating(true)

    try {
      await api.manifests.deleteBundle(manifestName)
      const remaining = manifests.filter(manifest => manifest.name !== manifestName)
      setManifests(remaining)
      setExpandedPaths(current =>
        activeManifestName === manifestName ? [] : current
      )
      setActiveManifest(current =>
        activeManifestName === manifestName ? null : current
      )
      setNoteDraft(current => (activeManifestName === manifestName ? "" : current))
      setEditingNotePath(current =>
        activeManifestName === manifestName ? null : current
      )
      setExportResult(current =>
        activeManifestName === manifestName ? null : current
      )

      if (activeManifestName === manifestName) {
        setActiveManifestName(remaining[0]?.name ?? null)
      }

      setBundleDialog(null)
      setOpenManifestMenuName(null)
      setErrorMessage(null)
      params.showToast("Bundle moved to trash")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsBundleMutating(false)
    }
  }, [activeManifestName, manifests, params])

  const submitBundleDialog = useCallback(async () => {
    if (!bundleDialog) {
      return
    }

    if (bundleDialog.kind === "rename") {
      await renameManifest(bundleDialog.manifestName, bundleDialog.value)
      return
    }

    if (bundleDialog.kind === "duplicate") {
      await duplicateManifest(bundleDialog.manifestName, bundleDialog.value)
      return
    }

    await deleteBundle(bundleDialog.manifestName)
  }, [bundleDialog, deleteBundle, duplicateManifest, renameManifest])

  const regenerateExport = useCallback(async () => {
    const api = window.handoffApp?.selector
    if (!api || !activeManifest) {
      return
    }

    setIsExporting(true)

    try {
      const manifestForExport = hasUnsavedExportSettings
        ? await api.manifests.setExportText(
            activeManifest.name,
            exportPrefixDraft,
            exportSuffixDraft,
            stripCommentsDraft,
            gitDiffModeDraft
          )
        : activeManifest

      if (!manifestForExport) {
        return
      }

      if (hasUnsavedExportSettings) {
        setActiveManifest(manifestForExport)
        setManifests(current => mergeManifestSummaries(current, manifestForExport))
      }

      const result = await api.exports.regenerateAndCopy(manifestForExport.name)
      setExportResult(result)
      setErrorMessage(null)
      params.showToast("Regenerated and copied export")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    } finally {
      setIsExporting(false)
    }
  }, [
    activeManifest,
    exportPrefixDraft,
    exportSuffixDraft,
    gitDiffModeDraft,
    hasUnsavedExportSettings,
    params,
    stripCommentsDraft
  ])

  const refresh = useCallback(async () => {
    const api = window.handoffApp?.selector
    if (!api) {
      return
    }

    try {
      await api.app.refresh()
      await handleStateChanged()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(message)
      params.showToast(message, "error")
    }
  }, [handleStateChanged, params])

  const openAddFilesModal = useCallback(() => {
    if (!activeManifest) {
      return
    }

    setIsAddFilesModalOpen(true)
  }, [activeManifest])

  const hasRoots = roots.length > 0
  const hasManifests = manifests.length > 0
  const selectedFileCount =
    activeManifest?.files.filter(file => file.selected !== false).length ?? 0

  return {
    addFilesInputRef,
    activeManifest,
    activeManifestName,
    beginEditingNote,
    bundleDialog,
    bundleDialogInputRef,
    bundleFilterQuery,
    closeNoteEditor,
    deferredSearchQuery,
    deleteBundle,
    editingNotePath,
    errorMessage,
    estimateResult,
    expandedPaths,
    exportPrefixDraft,
    exportResult,
    exportSuffixDraft,
    filteredManifestFiles,
    gitDiffModeDraft,
    gitDiffStatsByPath,
    gitStatusByPath,
    hasManifests,
    hasRoots,
    hasSearchQuery,
    hasUnsavedExportSettings,
    includeFullFileWithDiffsDraft,
    isAddFilesModalOpen,
    isApplyingChangedSelection,
    isBundleMutating,
    isEstimating,
    isExporting,
    isManifestLoading,
    isModifiedOrNewOnlySelected,
    isOverviewLoading,
    isSavingExportSettings,
    isSearching,
    loadManifest,
    manifests,
    modifiedOrNewPaths,
    mutatingPaths,
    noteDraft,
    openAddFilesModal,
    openManifestMenuName,
    openPathInEditor,
    regenerateExport,
    refresh,
    roots,
    saveExportSettings,
    saveManifestComment,
    searchQuery,
    searchResults,
    selectedFileCount,
    selectedRootId,
    setActiveManifestName,
    setBundleDialog,
    setBundleFilterQuery,
    setExportPrefixDraft,
    setExportSuffixDraft,
    setGitDiffModeDraft,
    setManifestFileSelected,
    setNoteDraft,
    setOpenManifestMenuName,
    setSearchQuery,
    setSelectedRootId,
    setStripCommentsDraft,
    setChangedSelectionOnly,
    setIsAddFilesModalOpen,
    setIsBundleMutating,
    setIsSearching,
    setSearchResults,
    startTransition,
    stateInfo,
    stripCommentsDraft,
    submitBundleDialog,
    toggleExpandedPath,
    trackedFilesByPath,
    useGitDiffsDraft,
    removeManifestFile,
    addManifestFile
  }
}

type SelectorSectionController = ReturnType<typeof useSelectorSection>

export function SelectorSidebarPane({
  controller
}: {
  controller: SelectorSectionController
}) {
  if (controller.isOverviewLoading && controller.manifests.length === 0) {
    return (
      <div className="selector-sidebar">
        <div className="selector-sidebar-header">
          <span className="selector-sidebar-title">Selected bundles</span>
        </div>
        <SectionEmptyState
          title="Loading bundles"
          detail="Reading Selector state and manifest summaries."
        />
      </div>
    )
  }

  if (!controller.hasManifests) {
    return (
      <div className="selector-sidebar">
        <div className="selector-sidebar-header">
          <span className="selector-sidebar-title">Selected bundles</span>
        </div>
        <SectionEmptyState
          title="No manifests found"
          detail="No manifests were found in the Selector state directory."
        />
      </div>
    )
  }

  return (
    <div className="selector-sidebar">
      <div className="selector-sidebar-header">
        <span className="selector-sidebar-title">Selected bundles</span>
      </div>
      <div className="selector-sidebar-list" role="list">
        {sortManifestSummaries(controller.manifests).map(manifest => {
          const isMenuOpen = controller.openManifestMenuName === manifest.name

          return (
            <div
              className={`selector-manifest-row ${
                manifest.name === controller.activeManifestName ? "is-active" : ""
              }`}
              data-selector-manifest-menu
              key={manifest.name}
            >
              <button
                className="selector-manifest-button"
                onClick={() => {
                  controller.setOpenManifestMenuName(null)
                  controller.startTransition(() => {
                    controller.setActiveManifestName(manifest.name)
                  })
                }}
                type="button"
              >
                <div className="session-row-main">
                  <div className="session-title-group">
                    <span className="session-title">{manifest.name}</span>
                  </div>
                  <div className="session-row-meta">
                    <span className="session-time">
                      {formatTimestamp(manifest.updated_at)}
                    </span>
                  </div>
                </div>
                <span className="session-subtitle">{buildManifestMeta(manifest)}</span>
              </button>

              <div className="selector-manifest-menu">
                <button
                  aria-expanded={isMenuOpen}
                  aria-haspopup="menu"
                  aria-label="Bundle actions"
                  className="selector-manifest-menu-button"
                  onClick={event => {
                    event.stopPropagation()
                    controller.setOpenManifestMenuName(current =>
                      current === manifest.name ? null : manifest.name
                    )
                  }}
                  type="button"
                >
                  <EllipsisIcon />
                </button>
                {isMenuOpen ? (
                  <div className="selector-manifest-menu-popover" role="menu">
                    <button
                      className="selector-manifest-menu-item"
                      onClick={() => {
                        controller.setBundleDialog({
                          kind: "rename",
                          manifestName: manifest.name,
                          value: manifest.name
                        })
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      className="selector-manifest-menu-item"
                      onClick={() => {
                        controller.setBundleDialog({
                          kind: "duplicate",
                          manifestName: manifest.name,
                          value: `${manifest.name}-copy`
                        })
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Duplicate
                    </button>
                    <button
                      className="selector-manifest-menu-item is-danger"
                      onClick={() => {
                        controller.setBundleDialog({
                          kind: "delete",
                          manifestName: manifest.name
                        })
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SelectorDetailPane({
  controller
}: {
  controller: SelectorSectionController
}) {
  if (!controller.activeManifest && !controller.isManifestLoading) {
    return (
      <SectionEmptyState
        title="Choose a manifest"
        detail="Select a manifest to inspect or edit its file membership."
      />
    )
  }

  if (controller.isManifestLoading && !controller.activeManifest) {
    return (
      <SectionEmptyState
        title="Loading manifest"
        detail="Reading manifest contents and export settings."
      />
    )
  }

  if (!controller.activeManifest) {
    return null
  }

  return (
    <div className="selector-detail-layout">
      {!controller.hasRoots && !controller.isOverviewLoading ? (
        <p className="empty-copy">
          No Selector roots are configured. Update {controller.stateInfo?.configPath ?? "config.json"} and then use Add files.
        </p>
      ) : null}

      <div className="selector-detail-toolbar">
        <div>
          <p className="pane-label">Selected files</p>
          <h2>{controller.activeManifest.name}</h2>
        </div>
        <div className="selector-detail-toolbar-actions">
          <span className="count-pill">{controller.activeManifest.file_count}</span>
          <button
            className="accent-button compact-button"
            disabled={!controller.hasRoots || controller.isBundleMutating}
            onClick={controller.openAddFilesModal}
            type="button"
          >
            Add files
          </button>
        </div>
      </div>

      <div className="bundle-filter-bar">
        <label className="control bundle-filter-control">
          <span>Quick filter</span>
          <input
            onChange={event => {
              controller.setBundleFilterQuery(event.target.value)
            }}
            placeholder="Filter this bundle by name, path, or note"
            value={controller.bundleFilterQuery}
          />
        </label>
        <p className="filter-meta">
          {controller.filteredManifestFiles.length} visible of {controller.activeManifest.files.length}
        </p>
      </div>

      <div className="file-list">
        {controller.activeManifest.files.length === 0 ? (
          <p className="empty-copy">
            This manifest is empty. Use Add files to search a project root.
          </p>
        ) : controller.filteredManifestFiles.length === 0 ? (
          <p className="empty-copy">
            No files in this bundle match the current filter.
          </p>
        ) : null}

        {controller.filteredManifestFiles.map(file => {
          const busy = controller.mutatingPaths.includes(file.path)
          const isSelected = file.selected !== false
          const isExpanded = controller.expandedPaths.includes(file.path)
          const gitDiffStat = controller.gitDiffStatsByPath[file.path] ?? null
          const addedLines = gitDiffStat?.added_lines ?? 0
          const removedLines = gitDiffStat?.removed_lines ?? 0
          const hasGitDiff = hasGitDiffStat(gitDiffStat)
          const gitStatus = controller.gitStatusByPath[file.path] ?? null

          return (
            <div
              className={`file-card ${isSelected ? "is-selected" : "is-unselected"}`}
              key={file.path}
            >
              <div
                className="file-card-row"
                onClick={() => {
                  controller.toggleExpandedPath(file.path)
                }}
              >
                <div className="file-card-main">
                  <input
                    checked={isSelected}
                    disabled={busy}
                    onClick={event => {
                      event.stopPropagation()
                    }}
                    onChange={event => {
                      void controller.setManifestFileSelected(file.path, event.target.checked)
                    }}
                    type="checkbox"
                  />
                  <div className="file-copy">
                    <div className="file-heading">
                      <button
                        aria-label={`Toggle selection for ${file.relative_path}`}
                        className="file-name-button"
                        disabled={busy}
                        onClick={event => {
                          event.stopPropagation()
                          void controller.setManifestFileSelected(file.path, !isSelected)
                        }}
                        type="button"
                      >
                        {getFileName(file.relative_path)}
                      </button>
                      {hasGitDiff ? (
                        <span
                          aria-label={`Git diff: ${addedLines} additions and ${removedLines} removals`}
                          className="git-diff-badge"
                        >
                          <span className="git-diff-added">+{addedLines}</span>
                          <span className="git-diff-removed">-{removedLines}</span>
                        </span>
                      ) : gitStatus?.kind === "new" ? (
                        <span className="git-state-badge git-state-new">New</span>
                      ) : gitStatus?.kind === "modified" ? (
                        <span className="git-state-badge">Modified</span>
                      ) : null}
                      {file.comment ? (
                        <span aria-label="Has note" className="note-badge" title="Has note">
                          <NoteIcon />
                        </span>
                      ) : null}
                    </div>
                    <button
                      aria-label={`Open ${file.relative_path} in editor`}
                      className="path-button file-subpath"
                      onClick={event => {
                        event.stopPropagation()
                        void controller.openPathInEditor(file.path)
                      }}
                      type="button"
                    >
                      {file.relative_path}
                    </button>
                  </div>
                  <button
                    aria-label={`Toggle details for ${file.relative_path}`}
                    aria-expanded={isExpanded}
                    className="file-expand-button file-card-indicator"
                    onClick={event => {
                      event.stopPropagation()
                      controller.toggleExpandedPath(file.path)
                    }}
                    type="button"
                  >
                    <ChevronIcon expanded={isExpanded} />
                  </button>
                </div>

                <div className="file-card-actions">
                  <button
                    aria-label="Remove file"
                    className="icon-button"
                    disabled={busy}
                    onClick={event => {
                      event.stopPropagation()
                      void controller.removeManifestFile(file.path)
                    }}
                    type="button"
                  >
                    {busy ? "…" : <TrashIcon />}
                  </button>
                </div>
              </div>

              {isExpanded ? (
                <div className="file-card-details">
                  {controller.editingNotePath === file.path ? (
                    <>
                      <label className="control note-editor">
                        <span>Note</span>
                        <textarea
                          disabled={busy}
                          onChange={event => {
                            controller.setNoteDraft(event.target.value)
                          }}
                          placeholder="Add a note for this file"
                          rows={4}
                          value={controller.noteDraft}
                        />
                      </label>
                      <div className="detail-actions">
                        <button
                          className="ghost-button compact-button"
                          disabled={busy}
                          onClick={controller.closeNoteEditor}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="accent-button compact-button"
                          disabled={busy}
                          onClick={() => {
                            void controller.saveManifestComment(file.path)
                          }}
                          type="button"
                        >
                          Save note
                        </button>
                      </div>
                    </>
                  ) : file.comment ? (
                    <>
                      <p className="detail-copy">{file.comment}</p>
                      <button
                        className="detail-link-button"
                        disabled={busy}
                        onClick={() => {
                          controller.beginEditingNote(file.path, file.comment)
                        }}
                        type="button"
                      >
                        Edit note
                      </button>
                    </>
                  ) : (
                    <button
                      className="detail-link-button"
                      disabled={busy}
                      onClick={() => {
                        controller.beginEditingNote(file.path, file.comment)
                      }}
                      type="button"
                    >
                      Add note
                    </button>
                  )}
                  <button
                    aria-label={`Open ${file.path} in editor`}
                    className="path-button detail-path"
                    disabled={busy}
                    onClick={() => {
                      void controller.openPathInEditor(file.path)
                    }}
                    type="button"
                  >
                    {file.path}
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="export-card selector-export-card">
        <div>
          <p className="pane-label">Latest export</p>
          <h3>{renderExportSummary(controller.exportResult)}</h3>
        </div>

        <div className="text-block-grid">
          <label className="control">
            <span>Text before export</span>
            <textarea
              className="text-block-input"
              onBlur={() => {
                void controller.saveExportSettings()
              }}
              onChange={event => {
                controller.setExportPrefixDraft(event.target.value)
              }}
              placeholder="Optional raw text inserted before the tagged export bundle."
              rows={4}
              value={controller.exportPrefixDraft}
            />
          </label>
          <label className="control">
            <span>Text after export</span>
            <textarea
              className="text-block-input"
              onBlur={() => {
                void controller.saveExportSettings()
              }}
              onChange={event => {
                controller.setExportSuffixDraft(event.target.value)
              }}
              placeholder="Optional raw text appended after the tagged export bundle."
              rows={4}
              value={controller.exportSuffixDraft}
            />
          </label>
        </div>

        <div className="export-actions">
          <p className="text-block-help">
            These blocks are emitted as raw text with no Selector tags.
          </p>
          <button
            className="ghost-button compact-button"
            disabled={!controller.hasUnsavedExportSettings || controller.isSavingExportSettings}
            onClick={() => {
              void controller.saveExportSettings()
            }}
            type="button"
          >
            {controller.isSavingExportSettings ? "Saving…" : "Save Text Blocks"}
          </button>
        </div>

        {controller.exportResult ? (
          <>
            <p className="export-path">{controller.exportResult.output_path}</p>
            {controller.exportResult.skipped_files.length > 0 ? (
              <p className="warning-copy">
                {controller.exportResult.skipped_files.length} file
                {controller.exportResult.skipped_files.length === 1 ? "" : "s"} skipped during export.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="selector-summary-bar">
        <div className="selector-summary-bar-inner">
          <div className="selector-summary-bar-row">
            <div className="summary-copy">
              <strong>
                {controller.isEstimating
                  ? "Estimating…"
                  : formatEstimatedTokens(controller.estimateResult)}
              </strong>
              <span>
                {controller.selectedFileCount} selected file
                {controller.selectedFileCount === 1 ? "" : "s"}
                {controller.estimateResult?.skipped_files.length
                  ? `, ${controller.estimateResult.skipped_files.length} skipped`
                  : ""}
              </span>
            </div>
            <div className="summary-actions selector-summary-actions">
              <label className="summary-toggle">
                <input
                  checked={controller.isModifiedOrNewOnlySelected}
                  disabled={
                    controller.isApplyingChangedSelection ||
                    (controller.modifiedOrNewPaths.length === 0 &&
                      !controller.isModifiedOrNewOnlySelected)
                  }
                  onChange={event => {
                    void controller.setChangedSelectionOnly(event.target.checked)
                  }}
                  type="checkbox"
                />
                <span>Only modified/new</span>
              </label>
              <label className="summary-toggle">
                <input
                  checked={controller.stripCommentsDraft}
                  disabled={controller.isSavingExportSettings}
                  onChange={event => {
                    const nextStripComments = event.target.checked
                    controller.setStripCommentsDraft(nextStripComments)
                    void controller.saveExportSettings(false, {
                      stripComments: nextStripComments
                    })
                  }}
                  type="checkbox"
                />
                <span>Strip comments</span>
              </label>
              <label className="summary-toggle">
                <input
                  checked={controller.useGitDiffsDraft}
                  disabled={controller.isSavingExportSettings}
                  onChange={event => {
                    const nextGitDiffMode = event.target.checked
                      ? GIT_DIFF_MODE_DIFF_ONLY
                      : GIT_DIFF_MODE_OFF
                    controller.setGitDiffModeDraft(nextGitDiffMode)
                    void controller.saveExportSettings(false, {
                      gitDiffMode: nextGitDiffMode
                    })
                  }}
                  type="checkbox"
                />
                <span>Use git diffs</span>
              </label>
              {controller.useGitDiffsDraft ? (
                <label className="summary-toggle">
                  <input
                    checked={controller.includeFullFileWithDiffsDraft}
                    disabled={controller.isSavingExportSettings}
                    onChange={event => {
                      const nextGitDiffMode = event.target.checked
                        ? GIT_DIFF_MODE_FULL_FILE_PLUS_DIFF
                        : GIT_DIFF_MODE_DIFF_ONLY
                      controller.setGitDiffModeDraft(nextGitDiffMode)
                      void controller.saveExportSettings(false, {
                        gitDiffMode: nextGitDiffMode
                      })
                    }}
                    type="checkbox"
                  />
                  <span>Include full file with diffs</span>
                </label>
              ) : null}
              <button
                className="accent-button"
                disabled={!controller.activeManifest || controller.isExporting || controller.isBundleMutating}
                onClick={() => {
                  void controller.regenerateExport()
                }}
                type="button"
              >
                {controller.isExporting ? "Regenerating…" : "Regenerate + Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SelectorAddFilesModal({
  controller
}: {
  controller: SelectorSectionController
}) {
  if (!controller.isAddFilesModalOpen) {
    return null
  }

  return (
    <div
      className="modal-scrim"
      onClick={event => {
        if (event.target === event.currentTarget) {
          controller.setIsAddFilesModalOpen(false)
        }
      }}
    >
      <section aria-label="Add files" aria-modal="true" className="modal-card" role="dialog">
        <div className="modal-header">
          <div>
            <p className="pane-label">Manual add</p>
            <h2>Search project files</h2>
          </div>
          <div className="modal-toolbar">
            <span className="count-pill">
              {controller.hasSearchQuery ? controller.searchResults.length : 0}
            </span>
            <button
              className="ghost-button compact-button"
              onClick={() => {
                controller.setIsAddFilesModalOpen(false)
              }}
              type="button"
            >
              Close
            </button>
          </div>
        </div>

        {!controller.hasRoots && !controller.isOverviewLoading ? (
          <p className="empty-copy">
            No Selector roots are configured. Update {controller.stateInfo?.configPath ?? "config.json"} and refresh.
          </p>
        ) : null}

        <div className="search-controls">
          <label className="control">
            <span>Root</span>
            <select
              disabled={!controller.hasRoots || !controller.activeManifest}
              onChange={event => {
                controller.startTransition(() => {
                  controller.setSelectedRootId(event.target.value)
                })
              }}
              value={controller.selectedRootId}
            >
              {controller.roots.map(root => (
                <option key={root.id} value={root.id}>
                  {root.id}
                </option>
              ))}
            </select>
          </label>

          <label className="control">
            <span>Query</span>
            <input
              disabled={!controller.hasRoots || !controller.activeManifest}
              onChange={event => {
                controller.setSearchQuery(event.target.value)
              }}
              placeholder="Search by file name or path"
              ref={controller.addFilesInputRef}
              value={controller.searchQuery}
            />
          </label>
        </div>

        {!controller.activeManifest ? (
          <p className="empty-copy">Select a manifest before adding files from search results.</p>
        ) : null}

        {controller.activeManifest && !controller.deferredSearchQuery ? (
          <p className="empty-copy">Enter a query to search within the selected root.</p>
        ) : null}

        {controller.activeManifest && controller.deferredSearchQuery && !controller.hasSearchQuery ? (
          <p className="empty-copy">
            Type at least {SEARCH_MIN_QUERY_LENGTH} characters to search this root.
          </p>
        ) : null}

        {controller.activeManifest && controller.hasSearchQuery ? (
          <div className="result-list modal-result-list">
            {controller.isSearching ? (
              <p className="empty-copy">Searching…</p>
            ) : controller.searchResults.length === 0 ? (
              <p className="empty-copy">No files matched this query.</p>
            ) : (
              controller.searchResults.map(file => {
                const busy = controller.mutatingPaths.includes(file.path)
                const trackedEntry = controller.trackedFilesByPath.get(file.path)
                const isSelected =
                  trackedEntry?.selected !== false && Boolean(trackedEntry)
                const buttonLabel = !trackedEntry
                  ? "Add"
                  : trackedEntry.selected === false
                    ? "Select"
                    : "Selected"

                return (
                  <div className={`result-card ${trackedEntry ? "is-tracked" : ""}`} key={file.path}>
                    <div className="result-copy">
                      <p className="result-name">{getFileName(file.relative_path)}</p>
                      <button
                        aria-label={`Open ${file.relative_path} in editor`}
                        className="path-button result-subpath"
                        onClick={() => {
                          void controller.openPathInEditor(file.path)
                        }}
                        type="button"
                      >
                        {file.relative_path}
                      </button>
                    </div>
                    <button
                      className={isSelected ? "ghost-button" : "accent-button"}
                      disabled={busy || isSelected}
                      onClick={() => {
                        void controller.addManifestFile(file.path)
                      }}
                      type="button"
                    >
                      {busy ? "Updating…" : buttonLabel}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}

export function SelectorBundleDialog({
  controller
}: {
  controller: SelectorSectionController
}) {
  if (!controller.bundleDialog) {
    return null
  }

  return (
    <div
      className="modal-scrim"
      onClick={event => {
        if (event.target === event.currentTarget) {
          controller.setBundleDialog(null)
        }
      }}
    >
      <section
        aria-label={
          controller.bundleDialog.kind === "rename"
            ? "Rename bundle"
            : controller.bundleDialog.kind === "duplicate"
              ? "Duplicate bundle"
              : "Delete bundle"
        }
        aria-modal="true"
        className="modal-card bundle-dialog-card"
        role="dialog"
      >
        <div className="modal-header">
          <div>
            <p className="pane-label">Bundle action</p>
            <h2>
              {controller.bundleDialog.kind === "rename"
                ? "Rename bundle"
                : controller.bundleDialog.kind === "duplicate"
                  ? "Duplicate bundle"
                  : "Delete bundle"}
            </h2>
          </div>
        </div>

        {controller.bundleDialog.kind === "delete" ? (
          <p className="dialog-copy">
            Move bundle "{controller.bundleDialog.manifestName}" and its export file to trash?
          </p>
        ) : (
          <label className="control">
            <span>
              {controller.bundleDialog.kind === "rename" ? "New name" : "Duplicate as"}
            </span>
            <input
              onChange={event => {
                controller.setBundleDialog(current =>
                  current && current.kind !== "delete"
                    ? { ...current, value: event.target.value }
                    : current
                )
              }}
              ref={controller.bundleDialogInputRef}
              value={controller.bundleDialog.value}
            />
          </label>
        )}

        <div className="dialog-actions">
          <button
            className="ghost-button compact-button"
            disabled={controller.isBundleMutating}
            onClick={() => {
              controller.setBundleDialog(null)
            }}
            type="button"
          >
            Cancel
          </button>
          <button
            className={`compact-button ${
              controller.bundleDialog.kind === "delete" ? "danger-button" : "accent-button"
            }`}
            disabled={
              controller.isBundleMutating ||
              (controller.bundleDialog.kind !== "delete" && !controller.bundleDialog.value.trim())
            }
            onClick={() => {
              void controller.submitBundleDialog()
            }}
            type="button"
          >
            {controller.isBundleMutating
              ? controller.bundleDialog.kind === "delete"
                ? "Deleting…"
                : "Saving…"
              : controller.bundleDialog.kind === "rename"
                ? "Rename"
                : controller.bundleDialog.kind === "duplicate"
                  ? "Duplicate"
                  : "Delete"}
          </button>
        </div>
      </section>
    </div>
  )
}
