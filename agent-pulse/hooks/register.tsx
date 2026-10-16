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
let pollTimer: Timer | null = null

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
  return status.toUpperCase()
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

function countBadgeSvg(activeCount: number, finishedCount: number): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="190" height="24" viewBox="0 0 190 24">',
    '<rect width="82" height="24" rx="7" fill="#2b2b2b"/>',
    '<circle cx="12" cy="12" r="4" fill="#22c55e"/>',
    '<text x="48" y="16" text-anchor="middle" fill="#f5f5f5" ',
    'font-family="system-ui, sans-serif" font-size="13" font-weight="600">',
    `${activeCount} active</text>`,
    '<rect x="90" width="100" height="24" rx="7" fill="#d4d4d4"/>',
    '<text x="140" y="16" text-anchor="middle" fill="#171717" ',
    'font-family="system-ui, sans-serif" font-size="13" font-weight="600">',
    `${finishedCount} finished</text>`,
    '</svg>',
  ].join('')
}

function sameAgent(left: AgentInfo, right: AgentInfo): boolean {
  return left.description === right.description
    && left.type === right.type
    && left.status === right.status
    && left.parentId === right.parentId
    && left.name === right.name
}

function resetState(): void {
  records.clear()
  selectedAgentId = ''
  transcript = []
  transcriptLoading = false
  transcriptError = ''
  currentTime = 0
  didAutoOpen = false
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
  const [agents, now] = await Promise.all([$.agent.list(), $.clock.now()])
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
  selectedAgentId = agentId
  transcript = []
  transcriptError = ''
  transcriptLoading = true
  $.ui.invalidate('ui.render')

  try {
    const result = await $.session.messages({ agentId })
    if (selectedAgentId !== agentId) return

    if (Array.isArray(result)) {
      transcript = result.slice(-TRANSCRIPT_LIMIT)
    } else {
      transcriptError = result.deny
    }
  } catch (error) {
    if (selectedAgentId !== agentId) return
    transcriptError = error instanceof Error ? error.message : String(error)
  } finally {
    if (selectedAgentId === agentId) {
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
    resetState()
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
    pollTimer?.cancel()
    pollTimer = null
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
    const result = await next(event)

    if ('agentId' in result && result.agentId) {
      try {
        const now = await $.clock.now()
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
    const agentId = event.agentId
    const record = agentId ? records.get(agentId) : undefined

    if (record) {
      record.currentTool = event.tool
      record.lastChangedAt = await $.clock.now()
      $.ui.invalidate('ui.render')
    }

    const result = await next(event)

    if (record) {
      record.currentTool = ''
      record.lastTool = event.tool
      record.lastChangedAt = await $.clock.now()
      $.ui.invalidate('ui.render')
      void refreshAgents($)
    }

    return result
  }).catch(($, event, next) => next(event))

  on('turn.complete', async ($, event, next) => {
    const result = await next(event)
    if (!event.agentId) return result

    const record = records.get(event.agentId)
    if (record) {
      record.currentTool = ''
      record.lastChangedAt = await $.clock.now()
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

      return (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center" width="100%">
            <Button
              key="agent-back"
              label="Back"
              plain
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
              plain
              dimColor
              onPress={() => {
                void loadTranscript($, selected.info.id)
              }}
            />
          </Box>

          <Box flexDirection="column">
            <Box justifyContent="space-between" width="100%">
              <Text bold wrap="truncate">{displayName(selected.info)}</Text>
              <Text color={statusColor(selected.info.status)} bold>
                {statusLabel(selected.info.status)}
              </Text>
            </Box>
            <Text dimColor>
              {selected.info.type}  {durationLabel(elapsedTime(selected))}
            </Text>
            {selected.info.parentId && (
              <Text dimColor wrap="truncate">Parent: {selected.info.parentId}</Text>
            )}
            {(selected.currentTool || selected.lastTool) && (
              <Text dimColor>
                {selected.currentTool ? 'Using' : 'Last tool'}: {selected.currentTool || selected.lastTool}
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
    const activeCount = agents.filter(agent => !isFinished(agent.info.status)).length
    const finishedCount = agents.length - activeCount
    const countBadges = event.surface === 'desktop'
      ? (() => {
          const { Svg } = $.ui.resolve(event)
          return (
            <Svg
              source={countBadgeSvg(activeCount, finishedCount)}
              alt={`${activeCount} active, ${finishedCount} finished`}
              width={190}
              height={24}
            />
          )
        })()
      : (
          <Box gap={1}>
            <Box
              key="active-count"
              backgroundColor="subtle"
              paddingX={1}
            >
              <Text><Text color="success" bold>● {activeCount}</Text> active</Text>
            </Box>
            <Box
              key="finished-count"
              backgroundColor="inactive"
              paddingX={1}
            >
              <Text color="inverseText"><Text bold>{finishedCount}</Text> finished</Text>
            </Box>
          </Box>
        )

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" width="100%">
          <Text bold>Agent Pulse</Text>
          <Button
            key="agent-list-refresh"
            label="Refresh"
            plain
            dimColor
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
            {countBadges}
            <Box flexDirection="column" gap={1} marginTop={1}>
              {agents.map(agent => {
                const activity = agent.currentTool
                  ? `Using ${agent.currentTool}`
                  : agent.lastTool
                    ? `Last tool: ${agent.lastTool}`
                    : agent.info.type

                return (
                  <Box
                    key={`agent-card:${agent.info.id}`}
                    flexDirection="column"
                    borderStyle="round"
                    borderColor={statusColor(agent.info.status)}
                    paddingX={1}
                  >
                    <Box justifyContent="space-between" width="100%">
                      <Text color={statusColor(agent.info.status)} bold>
                        {statusLabel(agent.info.status)}
                      </Text>
                      <Text dimColor>{durationLabel(elapsedTime(agent))}</Text>
                    </Box>
                    <Text bold wrap="truncate">{displayName(agent.info)}</Text>
                    <Box justifyContent="space-between" alignItems="center" width="100%">
                      <Text dimColor wrap="truncate">{activity}</Text>
                      <Button
                        key={`agent-view:${agent.info.id}`}
                        label="View"
                        plain
                        onPress={() => {
                          void loadTranscript($, agent.info.id)
                        }}
                      />
                    </Box>
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
