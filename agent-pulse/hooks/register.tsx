import type {
  AgentInfo,
  AgentStatus,
  EngineInterface,
  Register,
  SessionMessage,
  Timer,
} from 'claude-code'

const PANE = 'agent-pulse'
const POLL_INTERVAL_MS = 2_000
const TRANSCRIPT_LIMIT = 8
const TRANSCRIPT_TEXT_LIMIT = 600

type AgentRecord = {
  info: AgentInfo
  firstSeenAt: number
  lastChangedAt: number
  currentTool: string
  lastTool: string
}

const records = new Map<string, AgentRecord>()
let selectedAgentId = ''
let transcript: SessionMessage[] = []
let transcriptLoading = false
let transcriptError = ''
let currentTime = 0
let didAutoOpen = false
let showFinished = false
let pollTimer: Timer | null = null
let sessionGeneration = 0

function isFinished(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function statusColor(status: AgentStatus): 'success' | 'error' | 'warning' | 'accent' | 'inactive' {
  if (status === 'running' || status === 'completed') return 'success'
  if (status === 'failed' || status === 'killed') return 'error'
  if (status === 'waiting') return 'warning'
  if (status === 'idle') return 'inactive'
  return 'accent'
}

function statusLabel(status: AgentStatus): string {
  if (status === 'running') return 'Running'
  if (status === 'waiting') return 'Waiting'
  if (status === 'idle') return 'Idle'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  if (status === 'killed') return 'Killed'
  return 'Pending'
}

function displayName(info: AgentInfo): string {
  return info.name || info.description || info.type
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function elapsedTime(record: AgentRecord): number {
  const end = isFinished(record.info.status) ? record.lastChangedAt : currentTime
  return end - record.firstSeenAt
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= TRANSCRIPT_TEXT_LIMIT) return normalized
  return `${normalized.slice(0, TRANSCRIPT_TEXT_LIMIT - 3)}...`
}

function sameAgent(left: AgentInfo, right: AgentInfo): boolean {
  return left.description === right.description
    && left.type === right.type
    && left.status === right.status
    && left.parentId === right.parentId
    && left.name === right.name
}

function clearSessionState(): void {
  sessionGeneration += 1
  records.clear()
  selectedAgentId = ''
  transcript = []
  transcriptLoading = false
  transcriptError = ''
  currentTime = 0
  didAutoOpen = false
  showFinished = false
}

function stopPolling(): void {
  pollTimer?.cancel()
  pollTimer = null
}

function rememberAgent(info: AgentInfo, now: number): boolean {
  const existing = records.get(info.id)

  if (!existing) {
    records.set(info.id, {
      info,
      firstSeenAt: now,
      lastChangedAt: now,
      currentTool: '',
      lastTool: '',
    })
    return true
  }

  if (!sameAgent(existing.info, info)) {
    existing.info = info
    existing.lastChangedAt = now
    return true
  }

  return false
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const generation = sessionGeneration
  const [agents, now] = await Promise.all([$.agent.list(), $.clock.now()])
  if (generation !== sessionGeneration) return

  let changed = currentTime !== now
  currentTime = now

  for (const agent of agents) {
    changed = rememberAgent(agent, now) || changed
  }

  if (agents.length > 0 && !didAutoOpen) {
    didAutoOpen = true
    void $.ui.open({ id: PANE, title: 'Agents', columns: 58 })
  }

  if (changed) $.ui.invalidate('ui.render')
}

async function refreshOpenPane($: EngineInterface): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(item => item.id === PANE)
    if (!pane?.isPlaced || !pane.isShown) return
    await refreshAgents($)
  } catch {
    // A refresh failure should never affect Claude's work.
  }
}

async function loadTranscript($: EngineInterface, agentId: string): Promise<void> {
  const generation = sessionGeneration
  selectedAgentId = agentId
  transcript = []
  transcriptError = ''
  transcriptLoading = true
  $.ui.invalidate('ui.render')

  try {
    const result = await $.session.messages({ agentId })
    if (generation !== sessionGeneration || selectedAgentId !== agentId) return

    if (Array.isArray(result)) {
      transcript = result.slice(-TRANSCRIPT_LIMIT)
    } else {
      transcriptError = result.deny
    }
  } catch (error) {
    if (generation !== sessionGeneration || selectedAgentId !== agentId) return
    transcriptError = error instanceof Error ? error.message : String(error)
  } finally {
    if (generation === sessionGeneration && selectedAgentId === agentId) {
      transcriptLoading = false
      $.ui.invalidate('ui.render')
    }
  }
}

function seedSpawnedAgent(
  agentId: string,
  event: {
    description: string
    subagentType: string
    parentAgentId?: string
    name?: string
  },
  now: number,
): void {
  rememberAgent({
    id: agentId,
    description: event.description,
    type: event.subagentType,
    status: 'running',
    parentId: event.parentAgentId,
    name: event.name,
  }, now)
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    stopPolling()
    clearSessionState()
    await $.command.register({
      name: 'agent-pulse',
      description: 'Open the live subagent activity pane',
    })
    pollTimer = $.clock.every(POLL_INTERVAL_MS, () => {
      void refreshOpenPane($)
    })
    return next(event)
  })

  on('session.end', ($, event, next) => {
    if (event.reason === 'clear' || event.reason === 'resume') {
      clearSessionState()
      $.ui.invalidate('ui.render')
    } else {
      stopPolling()
    }
    return next(event)
  })

  on('command.run', { command: 'agent-pulse' }, async $ => {
    await $.ui.open({
      id: PANE,
      title: 'Agents',
      focus: true,
      closeOnEscape: true,
      columns: 58,
    })

    try {
      await refreshAgents($)
    } catch {
      $.ui.invalidate('ui.render')
    }

    return { text: 'Agent activity pane opened.' }
  }).catch(() => ({ text: 'Agent Pulse could not open the activity pane.' }))

  on('agent.spawn', async ($, event, next) => {
    const generation = sessionGeneration
    const result = await next(event)
    if (generation !== sessionGeneration) return result

    if ('agentId' in result && result.agentId) {
      try {
        const now = await $.clock.now()
        if (generation !== sessionGeneration) return result
        currentTime = now
        seedSpawnedAgent(result.agentId, event, now)

        if (!didAutoOpen) {
          didAutoOpen = true
          void $.ui.open({ id: PANE, title: 'Agents', columns: 58 })
        }

        $.ui.invalidate('ui.render')
        void refreshAgents($)
      } catch {
        // Agent monitoring must not interfere with a successful spawn.
      }
    }

    return result
  }).catch(($, event, next) => next(event))

  on('tool.call', async ($, event, next) => {
    const generation = sessionGeneration
    const agentId = event.agentId
    const record = agentId ? records.get(agentId) : undefined

    if (record) {
      const now = await $.clock.now()
      if (generation !== sessionGeneration) return next(event)
      record.currentTool = event.tool
      record.lastChangedAt = now
      $.ui.invalidate('ui.render')
    }

    const result = await next(event)
    if (generation !== sessionGeneration) return result

    if (record) {
      const now = await $.clock.now()
      if (generation !== sessionGeneration) return result
      record.currentTool = ''
      record.lastTool = event.tool
      record.lastChangedAt = now
      $.ui.invalidate('ui.render')
      void refreshAgents($)
    }

    return result
  }).catch(($, event, next) => next(event))

  on('turn.complete', async ($, event, next) => {
    const generation = sessionGeneration
    const result = await next(event)
    if (generation !== sessionGeneration) return result
    if (!event.agentId) return result

    const record = records.get(event.agentId)
    if (record) {
      const now = await $.clock.now()
      if (generation !== sessionGeneration) return result
      record.currentTool = ''
      record.lastChangedAt = now
      $.ui.invalidate('ui.render')
    }

    if (selectedAgentId === event.agentId) void loadTranscript($, event.agentId)
    void refreshAgents($)
    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Text } = $.ui.resolve(event)
    const selected = selectedAgentId ? records.get(selectedAgentId) : undefined

    if (selected) {
      const messages = transcript
      const description = selected.info.description !== displayName(selected.info)
        ? selected.info.description
        : ''

      return (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
            <Button
              key="agent-back"
              label="Back"
              variant="secondary"
              onPress={() => {
                selectedAgentId = ''
                transcript = []
                transcriptError = ''
                $.ui.invalidate('ui.render')
              }}
            />
            <Button
              key="agent-transcript-refresh"
              label={transcriptLoading ? 'Loading' : 'Refresh'}
              variant="secondary"
              onPress={() => {
                void loadTranscript($, selected.info.id)
              }}
            />
          </Box>

          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={statusColor(selected.info.status)}
            paddingX={1}
            overflow="hidden"
          >
            <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
              <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Text color={statusColor(selected.info.status)} bold>●</Text>
                <Text bold wrap="truncate-end">{displayName(selected.info)}</Text>
              </Box>
              <Text dimColor>{durationLabel(elapsedTime(selected))}</Text>
            </Box>
            {description && <Text wrap="wrap">{description}</Text>}
            <Text color={statusColor(selected.info.status)}>{statusLabel(selected.info.status)}</Text>
            <Text dimColor>{selected.info.type} agent</Text>
            {selected.info.parentId && (
              <Text dimColor wrap="truncate-end">Parent: {selected.info.parentId}</Text>
            )}
            {(selected.currentTool || selected.lastTool) && (
              <Text dimColor>
                {selected.currentTool ? 'Using' : 'Last used'} {selected.currentTool || selected.lastTool}
              </Text>
            )}
          </Box>

          <Text bold>Recent transcript</Text>
          {transcriptLoading && <Text dimColor>Loading transcript...</Text>}
          {!transcriptLoading && transcriptError && <Text color="error">{transcriptError}</Text>}
          {!transcriptLoading && !transcriptError && messages.length === 0 && (
            <Text dimColor>No transcript is available yet.</Text>
          )}
          {!transcriptLoading && !transcriptError && messages.map((message, index) => {
            const tools = message.toolUses.map(tool => tool.tool).join(', ')
            const text = normalizeText(message.text)

            return (
              <Box key={`message-${index}`} flexDirection="column">
                <Text color={message.role === 'user' ? 'accent' : 'claude'} bold>
                  {message.role === 'user' ? 'Prompt' : 'Agent'}
                </Text>
                {text && <Text wrap="wrap">{text}</Text>}
                {tools && <Text dimColor wrap="wrap">Tools: {tools}</Text>}
              </Box>
            )
          })}
        </Box>
      )
    }

    const agents = [...records.values()].sort((left, right) => {
      const finishOrder = Number(isFinished(left.info.status)) - Number(isFinished(right.info.status))
      return finishOrder || right.lastChangedAt - left.lastChangedAt
    })
    const activeAgents = agents.filter(agent => !isFinished(agent.info.status))
    const finishedAgents = agents.filter(agent => isFinished(agent.info.status))
    const activeCount = activeAgents.length
    const finishedCount = finishedAgents.length

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
          <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text bold>Agent Pulse</Text>
            {agents.length > 0 && <Text dimColor>{agents.length} total</Text>}
          </Box>
          <Button
            key="agent-list-refresh"
            label="Refresh"
            variant="secondary"
            onPress={() => {
              void refreshAgents($)
            }}
          />
        </Box>

        {agents.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No subagents in this session.</Text>
            <Text dimColor>The pane updates when Claude starts one.</Text>
          </Box>
        ) : (
          <>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={activeCount > 0 ? 'success' : 'inactive'}
              paddingX={1}
              overflow="hidden"
            >
              <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
                <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  <Text color={activeCount > 0 ? 'success' : 'inactive'} bold>●</Text>
                  <Text bold wrap="truncate-end">
                    {activeCount === 0
                      ? 'No live agents'
                      : `${activeCount} live agent${activeCount === 1 ? '' : 's'}`}
                  </Text>
                </Box>
                <Text dimColor>{finishedCount} finished</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {activeCount > 0
                  ? 'Live activity updates every 2 seconds.'
                  : 'Waiting for the next subagent.'}
              </Text>
            </Box>

            {activeAgents.length > 0 && (
              <Box flexDirection="column" gap={1}>
                <Box gap={1}>
                  <Text bold>Live agents</Text>
                  <Text dimColor>{activeCount}</Text>
                </Box>
                {activeAgents.map(agent => {
                  const name = displayName(agent.info)
                  const description = agent.info.description !== name ? agent.info.description : ''
                  const activity = agent.currentTool
                    ? `Using ${agent.currentTool}`
                    : agent.lastTool
                      ? `Last used ${agent.lastTool}`
                      : `${agent.info.type} agent`

                  return (
                    <Box
                      key={`agent-card:${agent.info.id}`}
                      flexDirection="column"
                      borderStyle="round"
                      borderDimColor
                      paddingX={1}
                      overflow="hidden"
                    >
                      <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
                        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                          <Text color={statusColor(agent.info.status)} bold>●</Text>
                          <Text bold wrap="truncate-end">{name}</Text>
                        </Box>
                        <Text dimColor>{durationLabel(elapsedTime(agent))}</Text>
                      </Box>
                      {description && <Text wrap="truncate-end">{description}</Text>}
                      <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
                        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                          <Text color={statusColor(agent.info.status)}>{statusLabel(agent.info.status)}</Text>
                          <Text dimColor wrap="truncate-end">{activity}</Text>
                        </Box>
                        <Button
                          key={`agent-view:${agent.info.id}`}
                          label="Details"
                          variant="secondary"
                          onPress={() => {
                            void loadTranscript($, agent.info.id)
                          }}
                        />
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            )}

            <Box key="finished-section" flexDirection="column" gap={1} marginTop={1}>
              <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
                <Box gap={1}>
                  <Text bold>Finished</Text>
                  <Text dimColor>{finishedCount}</Text>
                </Box>
                {finishedCount > 0 && (
                  <Button
                    key="toggle-finished"
                    label={`${showFinished ? 'Hide' : 'Show'} ${finishedCount}`}
                    variant="secondary"
                    onPress={() => {
                      showFinished = !showFinished
                      $.ui.invalidate('ui.render')
                    }}
                  />
                )}
              </Box>

              {finishedCount === 0 && <Text dimColor>No finished agents yet.</Text>}
              {showFinished && finishedAgents.map(agent => {
                const name = displayName(agent.info)
                const description = agent.info.description !== name ? agent.info.description : ''
                const activity = agent.currentTool
                  ? `Using ${agent.currentTool}`
                  : agent.lastTool
                    ? `Last used ${agent.lastTool}`
                    : `${agent.info.type} agent`

                return (
                  <Box
                    key={`finished-agent:${agent.info.id}`}
                    justifyContent="space-between"
                    alignItems="center"
                    gap={1}
                    overflow="hidden"
                  >
                    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                      <Box gap={1} overflow="hidden">
                        <Text color={statusColor(agent.info.status)}>●</Text>
                        <Text bold wrap="truncate-end">{name}</Text>
                        <Text color={statusColor(agent.info.status)}>{statusLabel(agent.info.status)}</Text>
                      </Box>
                      {description && <Text wrap="truncate-end">{description}</Text>}
                      <Box justifyContent="space-between" gap={1} overflow="hidden">
                        <Text dimColor wrap="truncate-end">{activity}</Text>
                        <Text dimColor>{durationLabel(elapsedTime(agent))}</Text>
                      </Box>
                    </Box>
                    <Button
                      key={`agent-view:${agent.info.id}`}
                      label="Details"
                      variant="secondary"
                      onPress={() => {
                        void loadTranscript($, agent.info.id)
                      }}
                    />
                  </Box>
                )
              })}
            </Box>
          </>
        )}
      </Box>
    )
  })
}
