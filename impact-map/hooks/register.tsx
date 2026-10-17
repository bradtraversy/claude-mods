import type { EngineInterface, Register } from 'claude-code'

const PANE = 'impact-map'
const DIFF_PANE = 'impact-map-diff'
const MAX_DIFF_CHARS = 90_000
const MAX_RECENT_FILES = 14

type FileAction = 'read' | 'edited' | 'created'

type ImpactFile = {
  path: string
  action: FileAction
  stats?: DiffStats
}

type DiffResult = {
  source: string
  message: string
}

type DiffStats = {
  additions: number
  deletions: number
}

type ImpactFilter = 'all' | 'changed'

type FileGroup = {
  folder: string
  files: ImpactFile[]
}

const files = new Map<string, ImpactFile>()
let workspaceRoot = ''
let activeFilter: ImpactFilter = 'all'
let selectedFile: ImpactFile | null = null
let diffSource = ''
let diffMessage = ''
let diffError = ''
let diffLoading = false
let diffRequest = 0
let sessionGeneration = 0

function clearSessionState(): void {
  sessionGeneration += 1
  files.clear()
  workspaceRoot = ''
  activeFilter = 'all'
  selectedFile = null
  diffSource = ''
  diffMessage = ''
  diffError = ''
  diffLoading = false
  diffRequest += 1
}

function remember(path: string, action: FileAction, stats?: DiffStats): void {
  const previous = files.get(path)
  const nextAction = previous?.action === 'created'
    ? 'created'
    : previous?.action === 'edited' && action === 'read'
      ? 'edited'
      : action

  files.delete(path)
  files.set(path, {
    path,
    action: nextAction,
    stats: stats ?? previous?.stats,
  })

  if (files.size > MAX_RECENT_FILES) {
    const oldestPath = files.keys().next().value
    if (oldestPath !== undefined) files.delete(oldestPath)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function changeStats(output: unknown): DiffStats | undefined {
  if (!isRecord(output)) return undefined

  if (isRecord(output.gitDiff)) {
    const additions = output.gitDiff.additions
    const deletions = output.gitDiff.deletions
    if (typeof additions === 'number' && typeof deletions === 'number') {
      return { additions, deletions }
    }
  }

  if (!Array.isArray(output.structuredPatch)) return undefined

  const lines = output.structuredPatch.flatMap(patch => (
    isRecord(patch) && Array.isArray(patch.lines)
      ? patch.lines.filter((line): line is string => typeof line === 'string')
      : []
  ))
  if (lines.length === 0) return undefined

  return diffStats(lines.join('\n'))
}

function wasStaged(output: unknown): boolean {
  return isRecord(output) && output.staged === true
}

function writeAction(output: unknown): FileAction {
  return isRecord(output) && output.type === 'update' ? 'edited' : 'created'
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function folderLabel(path: string): string {
  const normalizedPath = path.replaceAll('\\', '/')
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/$/, '')
  const rootPrefix = normalizedRoot ? `${normalizedRoot}/` : ''

  if (rootPrefix && normalizedPath.startsWith(rootPrefix)) {
    const relative = normalizedPath.slice(rootPrefix.length)
    const folder = relative.split('/').slice(0, -1).join('/')
    return folder ? `${folder}/` : 'Project root'
  }

  const folder = normalizedPath.split('/').slice(0, -1).filter(Boolean).join('/')
  return folder ? `/${folder}/` : 'Outside project'
}

function groupFiles(entries: ImpactFile[]): FileGroup[] {
  const groups = new Map<string, ImpactFile[]>()

  for (const file of entries) {
    const folder = folderLabel(file.path)
    const group = groups.get(folder) ?? []
    group.push(file)
    groups.set(folder, group)
  }

  return [...groups.entries()].map(([folder, groupedFiles]) => ({
    folder,
    files: groupedFiles,
  }))
}

function actionGlyph(action: FileAction): string {
  if (action === 'read') return 'R'
  if (action === 'edited') return '~'
  return '+'
}

function actionColor(action: FileAction): 'accent' | 'warning' | 'success' {
  if (action === 'read') return 'accent'
  if (action === 'edited') return 'warning'
  return 'success'
}

function safeDiffPath(path: string): string {
  return path.replaceAll('\r', '?').replaceAll('\n', '?')
}

function addedFileDiff(path: string, content: string, cwd: string): string {
  if (!content) return ''

  const normalized = content.replaceAll('\r\n', '\n')
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n')
  const cwdPrefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  const relativePath = path.startsWith(cwdPrefix) ? path.slice(cwdPrefix.length) : path
  const headerPath = safeDiffPath(relativePath).replace(/^[/\\]+/, '')

  return [
    '--- /dev/null',
    `+++ b/${headerPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n')
}

function cleanGitDiff(source: string): string {
  const lines = source.split('\n')
  const fileHeader = lines.findIndex(line => line.startsWith('--- '))
  return fileHeader >= 0 ? lines.slice(fileHeader).join('\n') : source
}

function diffStats(source: string): DiffStats {
  return source.split('\n').reduce<DiffStats>((stats, line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) stats.additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) stats.deletions += 1
    return stats
  }, { additions: 0, deletions: 0 })
}

function checkedDiff(source: string): DiffResult {
  if (source.length > MAX_DIFF_CHARS) {
    return {
      source: '',
      message: `This diff is too large to display (${Math.round(source.length / 1_000)}k characters).`,
    }
  }

  return { source, message: '' }
}

async function readCurrentDiff($: EngineInterface, file: ImpactFile): Promise<DiffResult> {
  const cwd = await $.session.cwd()
  const diff = await $.process.run(
    ['git', 'diff', '--no-ext-diff', '--no-color', 'HEAD', '--', file.path],
    { cwd, timeoutMs: 10_000 },
  )

  if (diff.stdout) return checkedDiff(cleanGitDiff(diff.stdout))

  const tracked = await $.process.run(
    ['git', 'ls-files', '--error-unmatch', '--', file.path],
    { cwd, timeoutMs: 10_000 },
  )

  if (tracked.exitCode !== 0) {
    const content = await $.fs.read(file.path)
    if (!content) return { source: '', message: 'This new file is empty.' }
    return checkedDiff(addedFileDiff(file.path, content, cwd))
  }

  if (diff.exitCode !== 0) {
    return {
      source: '',
      message: diff.stderr.trim() || 'Git could not build a diff for this file.',
    }
  }

  return {
    source: '',
    message: 'No current Git diff. The change may have been committed or reverted.',
  }
}

async function refreshDiff($: EngineInterface, file: ImpactFile): Promise<void> {
  const request = ++diffRequest
  diffLoading = true
  diffSource = ''
  diffMessage = ''
  diffError = ''
  $.ui.invalidate('ui.render')

  try {
    const result = await readCurrentDiff($, file)
    if (request !== diffRequest) return
    diffSource = result.source
    diffMessage = result.message
  } catch (error) {
    if (request !== diffRequest) return
    diffError = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === diffRequest) {
      diffLoading = false
      $.ui.invalidate('ui.render')
    }
  }
}

async function openDiff($: EngineInterface, file: ImpactFile): Promise<void> {
  const generation = sessionGeneration
  selectedFile = file
  diffLoading = true
  diffSource = ''
  diffMessage = ''
  diffError = ''

  await $.ui.open({
    id: DIFF_PANE,
    title: `Diff: ${fileName(file.path).slice(0, 48)}`,
    focus: true,
    closeOnEscape: true,
    columns: 88,
  })
  if (generation !== sessionGeneration) return
  await refreshDiff($, file)
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    clearSessionState()
    workspaceRoot = event.cwd
    await $.command.register({
      name: 'impact-map',
      description: 'Open the workspace impact map',
    })
    void $.ui.open({ id: PANE, title: 'Impact Map' })
    return next(event)
  })

  on('session.end', ($, event, next) => {
    if (event.reason === 'clear' || event.reason === 'resume') {
      clearSessionState()
      $.ui.invalidate('ui.render')
    }
    return next(event)
  })

  on('command.run', { command: 'impact-map' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Impact Map', focus: true })
    return { text: 'Workspace impact map opened.' }
  })

  on('tool.call', async ($, event, next) => {
    const generation = sessionGeneration
    const result = await next(event)
    if (generation !== sessionGeneration) return result
    if ('deny' in result || result.isError) return result

    if (!workspaceRoot && (
      event.tool === 'Read' || event.tool === 'Edit' || event.tool === 'Write'
    )) {
      const cwd = await $.session.cwd()
      if (generation !== sessionGeneration) return result
      workspaceRoot = cwd
    }

    const output = 'result' in result ? result.result : undefined
    if (wasStaged(output)) return result

    if (event.tool === 'Read') remember(event.file_path, 'read')
    if (event.tool === 'Edit') remember(event.file_path, 'edited', changeStats(output))
    if (event.tool === 'Write') remember(
      event.file_path,
      writeAction(output),
      changeStats(output),
    )

    if (event.tool === 'Read' || event.tool === 'Edit' || event.tool === 'Write') {
      $.ui.invalidate('ui.render')
    }

    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Text } = $.ui.resolve(event)
    const entries = [...files.values()].reverse()

    if (entries.length === 0) return <Text dimColor>No files touched yet.</Text>

    const changedFiles = entries.filter(file => file.action !== 'read')
    const readFiles = entries.filter(file => file.action === 'read')
    const changedGroups = groupFiles(changedFiles)
    const readGroups = groupFiles(readFiles)
    const totals = changedFiles.reduce<DiffStats>((summary, file) => ({
      additions: summary.additions + (file.stats?.additions ?? 0),
      deletions: summary.deletions + (file.stats?.deletions ?? 0),
    }), { additions: 0, deletions: 0 })
    const hasStats = changedFiles.some(file => file.stats !== undefined)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
          <Box gap={1} flexWrap="wrap" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="warning" bold>{changedFiles.length} changed</Text>
            <Text dimColor>{readFiles.length} read</Text>
          </Box>
          {hasStats && (
            <Box gap={1} flexShrink={0}>
              <Text color="success" bold>+{totals.additions}</Text>
              <Text color="error" bold>-{totals.deletions}</Text>
            </Box>
          )}
        </Box>
        <Box gap={1} alignItems="center">
          <Button
            key="impact-filter-all"
            label="All"
            variant={activeFilter === 'all' ? 'primary' : 'secondary'}
            onPress={() => {
              activeFilter = 'all'
              $.ui.invalidate('ui.render')
            }}
          />
          <Button
            key="impact-filter-changed"
            label="Changed"
            variant={activeFilter === 'changed' ? 'primary' : 'secondary'}
            onPress={() => {
              activeFilter = 'changed'
              $.ui.invalidate('ui.render')
            }}
          />
        </Box>
        {changedFiles.length === 0 && activeFilter === 'changed' ? (
          <Text dimColor>No changed files yet.</Text>
        ) : changedFiles.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            <Text bold>Changes</Text>
            <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" gap={1}>
              {changedGroups.map(group => (
                <Box key={group.folder} flexDirection="column">
                  <Text dimColor wrap="truncate-middle">{group.folder}</Text>
                  <Box flexDirection="column">
                    {group.files.map(file => (
                      <Box
                        key={file.path}
                        justifyContent="space-between"
                        alignItems="center"
                        gap={1}
                        overflow="hidden"
                      >
                        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                          <Text color={actionColor(file.action)} bold>
                            {actionGlyph(file.action)}
                          </Text>
                          <Button
                            key={`impact-file:${file.path}`}
                            plain
                            onPress={() => {
                              void openDiff($, file)
                            }}
                          >
                            <Text bold wrap="truncate-end">{fileName(file.path)}</Text>
                            <Text dimColor> &gt;</Text>
                          </Button>
                        </Box>
                        {file.stats && (
                          <Box gap={1} flexShrink={0}>
                            <Text color="success">+{file.stats.additions}</Text>
                            <Text color="error">-{file.stats.deletions}</Text>
                          </Box>
                        )}
                      </Box>
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}
        {activeFilter === 'all' && readFiles.length > 0 && (
          <Box flexDirection="column" gap={1} marginTop={changedFiles.length > 0 ? 1 : 0}>
            <Text bold>Read</Text>
            <Box flexDirection="column" gap={1}>
              {readGroups.map(group => (
                <Box key={group.folder} flexDirection="column">
                  <Text dimColor wrap="truncate-middle">{group.folder}</Text>
                  <Box flexDirection="column" marginLeft={1}>
                    {group.files.map(file => (
                      <Box key={file.path} gap={1} overflow="hidden">
                        <Text color="accent" bold>R</Text>
                        <Text wrap="truncate-end">{fileName(file.path)}</Text>
                      </Box>
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, ($, event) => {
    const { Box, Button, Code, Text } = $.ui.resolve(event)
    const file = selectedFile
    const stats = diffStats(diffSource)

    if (!file) return <Text dimColor>Select a changed file from Impact Map.</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" width="100%">
          <Text bold>{fileName(file.path)}</Text>
          <Button
            key="refresh-impact-diff"
            label={diffLoading ? 'Loading' : 'Refresh'}
            plain
            dimColor
            onPress={() => {
              void refreshDiff($, file)
            }}
          />
        </Box>
        <Text dimColor wrap="truncate">{file.path}</Text>
        {diffLoading && <Text dimColor>Building current Git diff...</Text>}
        {!diffLoading && diffSource && (
          <Box flexDirection="column" gap={1}>
            <Box gap={2}>
              <Text color="success" bold>+{stats.additions} added</Text>
              <Text color="error" bold>-{stats.deletions} removed</Text>
            </Box>
            <Code source={diffSource} path={file.path} format="diff" wrap="wrap" />
          </Box>
        )}
        {!diffLoading && diffMessage && <Text dimColor>{diffMessage}</Text>}
        {!diffLoading && diffError && <Text color="error">{diffError}</Text>}
      </Box>
    )
  })
}
