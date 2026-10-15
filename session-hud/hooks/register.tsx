import type {
  ContextMcpTool,
  EngineInterface,
  Register,
  SessionContextBreakdown,
} from 'claude-code'
import { CONTEXT_MAX_TOKENS } from './config.ts'

const PANE = 'context-breakdown'
const MCP_SERVER_LIMIT = 5
const MCP_TOOLS_PER_PAGE = 10

let breakdown: SessionContextBreakdown | null = null
let breakdownError = ''
let breakdownLoading = false
let selectedMcpServer: string | null = null
let mcpPage = 0

type McpServerGroup = {
  name: string
  loadedTokens: number
  loadedTools: number
  deferredTools: number
  tools: ContextMcpTool[]
}

function meter(percent: number, width: number): { filled: string; remaining: string } {
  const safePercent = Math.min(Math.max(percent, 0), 100)
  const rounded = Math.round((safePercent / 100) * width)
  const filled = safePercent > 0 ? Math.max(1, rounded) : 0
  return {
    filled: '█'.repeat(filled),
    remaining: '░'.repeat(width - filled),
  }
}

function rateLimitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind.replaceAll('_', ' ')
}

function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }

  return `${Math.round(tokens / 1_000)}k`
}

function detailTokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }

  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toLocaleString()
}

function percentage(tokens: number, total: number): string {
  if (total <= 0) return '0%'
  const value = (tokens / total) * 100
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`
}

function usageColor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function friendlyName(value: string, maxLength = 28): string {
  const readable = value.replaceAll('_', ' ')
  if (readable.length <= maxLength) return readable
  return `${readable.slice(0, Math.max(1, maxLength - 3))}...`
}

function toolName(tool: ContextMcpTool): string {
  const prefix = `mcp__${tool.serverName}__`
  const shortName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
  return friendlyName(shortName, 32)
}

function groupMcpTools(tools: readonly ContextMcpTool[]): McpServerGroup[] {
  const groups = new Map<string, ContextMcpTool[]>()

  for (const tool of tools) {
    const group = groups.get(tool.serverName) ?? []
    group.push(tool)
    groups.set(tool.serverName, group)
  }

  return [...groups.entries()]
    .map(([name, serverTools]) => ({
      name,
      loadedTokens: serverTools
        .filter(tool => tool.isLoaded)
        .reduce((total, tool) => total + tool.tokens, 0),
      loadedTools: serverTools.filter(tool => tool.isLoaded).length,
      deferredTools: serverTools.filter(tool => !tool.isLoaded).length,
      tools: [...serverTools].sort((left, right) => {
        if (left.isLoaded !== right.isLoaded) return left.isLoaded ? -1 : 1
        return right.tokens - left.tokens || left.name.localeCompare(right.name)
      }),
    }))
    .sort((left, right) => {
      return right.loadedTokens - left.loadedTokens || left.name.localeCompare(right.name)
    })
}

async function refreshBreakdown($: EngineInterface, columns: number): Promise<void> {
  if (breakdownLoading) return

  breakdownLoading = true
  breakdownError = ''
  $.ui.invalidate('ui.render')

  try {
    const usage = await $.session.usage({ breakdown: 'full', columns })
    breakdown = usage.context.breakdown ?? null
    if (!breakdown) breakdownError = 'Claude Code did not return a context breakdown yet.'
  } catch (error) {
    breakdownError = error instanceof Error ? error.message : String(error)
  } finally {
    breakdownLoading = false
    $.ui.invalidate('ui.render')
  }
}

async function openBreakdown($: EngineInterface): Promise<void> {
  selectedMcpServer = null
  mcpPage = 0
  await $.ui.open({
    id: PANE,
    title: 'Context',
    focus: true,
    closeOnEscape: true,
    columns: 58,
  })
  await refreshBreakdown($, 58)
}

export const register: Register = on => {
  on('session.measure', ($, event, next) => {
    $.ui.invalidate('ui.render')
    return next(event)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.props.hasSurvey) return next(event)

    const { Box, Button, Text } = $.ui.resolve(event)
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    const percent = Math.max(0, Math.round((tokens / CONTEXT_MAX_TOKENS) * 100))
    const width = Math.max(8, Math.min(20, event.props.bodyColumns - 50))
    const primaryLimit = usage.rateLimits[0]
    const meterColor = usageColor(percent)
    const contextMeter = meter(percent, width)

    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center">
          <Text bold>Context {percent}% of {tokenLabel(CONTEXT_MAX_TOKENS)}</Text>
          <Box>
            <Text color={meterColor}>{contextMeter.filled}</Text>
            <Text color="inactive">{contextMeter.remaining}</Text>
          </Box>
          <Button
            key="context-details"
            label="Details"
            plain
            onPress={() => {
              void openBreakdown($)
            }}
          />
          {usage.cost && <Text dimColor>${usage.cost.usd.toFixed(2)}</Text>}
          {primaryLimit && (
            <Text dimColor>
              {rateLimitLabel(primaryLimit.kind)} {primaryLimit.percentUsed}%
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Text } = $.ui.resolve(event)
    const current = breakdown

    if (!current) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="center" width="100%">
            <Text bold>Context Breakdown</Text>
            <Button
              key="refresh-context"
              label={breakdownLoading ? 'Counting' : 'Refresh'}
              hotkey="r"
              plain
              dimColor
              onPress={() => {
                void refreshBreakdown($, event.props.bodyColumns)
              }}
            />
          </Box>
          {breakdownError ? (
            <Text color="error">{breakdownError}</Text>
          ) : (
            <Text dimColor>Counting context tokens...</Text>
          )}
        </Box>
      )
    }

    const usedCategories = current.categories
      .filter(category => category.kind === 'used')
      .sort((left, right) => right.tokens - left.tokens)
    const freeTokens = current.categories
      .filter(category => category.kind === 'free')
      .reduce((total, category) => total + category.tokens, 0)
    const bufferTokens = current.categories
      .filter(category => category.kind === 'buffer')
      .reduce((total, category) => total + category.tokens, 0)
    const deferredTokens = current.categories
      .filter(category => category.kind === 'deferred')
      .reduce((total, category) => total + category.tokens, 0)
    const personalPercent = Math.max(
      0,
      Math.round((current.totalTokens / CONTEXT_MAX_TOKENS) * 100),
    )
    const windowPercent = Math.max(
      0,
      Math.round((current.totalTokens / current.rawMaxTokens) * 100),
    )
    const barWidth = Math.max(12, Math.min(34, event.props.bodyColumns - 8))
    const shortBarWidth = Math.max(10, Math.min(22, event.props.bodyColumns - 20))
    const progressBar = (
      percent: number,
      width: number,
      color: 'success' | 'warning' | 'error' = 'success',
    ) => {
      const progress = meter(percent, width)
      return (
        <Box>
          <Text color={color}>{progress.filled}</Text>
          <Text color="inactive">{progress.remaining}</Text>
        </Box>
      )
    }
    const mcpServers = groupMcpTools(current.mcpTools)
    const mcpLoadedTokens = mcpServers.reduce((total, server) => total + server.loadedTokens, 0)
    const selectedServer = mcpServers.find(server => server.name === selectedMcpServer)
    const maxMcpPage = selectedServer
      ? Math.max(0, Math.ceil(selectedServer.tools.length / MCP_TOOLS_PER_PAGE) - 1)
      : 0
    const visibleMcpPage = Math.min(mcpPage, maxMcpPage)
    const visibleMcpTools = selectedServer?.tools.slice(
      visibleMcpPage * MCP_TOOLS_PER_PAGE,
      (visibleMcpPage + 1) * MCP_TOOLS_PER_PAGE,
    ) ?? []
    const serverPicker = event.surface === 'mobile' ? (
      <Text dimColor>Tool details are available in desktop and terminal.</Text>
    ) : (() => {
      const { Select } = $.ui.resolve(event)
      return (
        <Select
          key="mcp-server-select"
          label="Tool details"
          value={selectedServer?.name ?? ''}
          options={[
            { value: '', label: 'Choose a server' },
            ...mcpServers.map(server => ({
              value: server.name,
              label: `${friendlyName(server.name, 32)} (${server.tools.length})`,
            })),
          ]}
          onSelect={value => {
            selectedMcpServer = value || null
            mcpPage = 0
            $.ui.invalidate('ui.render')
          }}
        />
      )
    })()

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" width="100%">
          <Text bold>Context Breakdown</Text>
          <Button
            key="refresh-context"
            label={breakdownLoading ? 'Counting' : 'Refresh'}
            hotkey="r"
            plain
            dimColor
            onPress={() => {
              void refreshBreakdown($, event.props.bodyColumns)
            }}
          />
        </Box>

        <Box flexDirection="column">
          <Box justifyContent="space-between" width="100%">
            <Text bold>{detailTokenLabel(current.totalTokens)} / {tokenLabel(CONTEXT_MAX_TOKENS)} target</Text>
            <Text color={usageColor(personalPercent)} bold>{personalPercent}%</Text>
          </Box>
          {progressBar(personalPercent, barWidth, usageColor(personalPercent))}
          <Text dimColor>{current.model} · {tokenLabel(current.rawMaxTokens)} model window</Text>
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>What is using context</Text>
          {usedCategories.map(category => {
            const share = current.totalTokens > 0
              ? (category.tokens / current.totalTokens) * 100
              : 0

            return (
              <Box key={`${category.kind}:${category.name}`} flexDirection="column">
                <Box justifyContent="space-between" width="100%" gap={1}>
                  <Text wrap="truncate">{category.name}</Text>
                  <Text dimColor>{detailTokenLabel(category.tokens)} · {percentage(category.tokens, current.totalTokens)}</Text>
                </Box>
                {progressBar(share, barWidth)}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between" width="100%">
            <Text bold>Model window</Text>
            <Text dimColor>{detailTokenLabel(current.totalTokens)} / {tokenLabel(current.rawMaxTokens)}</Text>
          </Box>
          {progressBar(windowPercent, barWidth, usageColor(windowPercent))}
          <Box gap={2} flexWrap="wrap">
            {freeTokens > 0 && <Text dimColor>Free {detailTokenLabel(freeTokens)}</Text>}
            {bufferTokens > 0 && <Text dimColor>Buffer {detailTokenLabel(bufferTokens)}</Text>}
            {deferredTokens > 0 && <Text dimColor>Deferred {detailTokenLabel(deferredTokens)}</Text>}
          </Box>
        </Box>

        {mcpServers.length > 0 && (
          <Box flexDirection="column" gap={1} marginTop={1}>
            <Box justifyContent="space-between" width="100%">
              <Text bold>MCP servers</Text>
              <Text dimColor>{detailTokenLabel(mcpLoadedTokens)} loaded</Text>
            </Box>

            {mcpServers.slice(0, MCP_SERVER_LIMIT).map(server => {
              const share = mcpLoadedTokens > 0
                ? (server.loadedTokens / mcpLoadedTokens) * 100
                : 0

              return (
                <Box key={`mcp-server-${server.name}`} flexDirection="column">
                  <Box justifyContent="space-between" width="100%" gap={1}>
                    <Text wrap="truncate">{friendlyName(server.name)}</Text>
                    <Text dimColor>
                      {detailTokenLabel(server.loadedTokens)} · {server.loadedTools}/{server.tools.length} tools
                    </Text>
                  </Box>
                  {progressBar(share, barWidth)}
                </Box>
              )
            })}

            {mcpServers.length > MCP_SERVER_LIMIT && (
              <Text dimColor>{mcpServers.length - MCP_SERVER_LIMIT} more servers in the picker</Text>
            )}

            {serverPicker}

            {selectedServer && (
              <Box flexDirection="column" gap={1}>
                <Box justifyContent="space-between" alignItems="center" width="100%">
                  <Text bold>{friendlyName(selectedServer.name)} tools</Text>
                  <Box gap={1}>
                    <Text dimColor>
                      {visibleMcpPage * MCP_TOOLS_PER_PAGE + 1}-{Math.min((visibleMcpPage + 1) * MCP_TOOLS_PER_PAGE, selectedServer.tools.length)} of {selectedServer.tools.length}
                    </Text>
                    {visibleMcpPage > 0 && (
                      <Button
                        key="mcp-previous"
                        label="Previous"
                        plain
                        onPress={() => {
                          mcpPage = Math.max(0, visibleMcpPage - 1)
                          $.ui.invalidate('ui.render')
                        }}
                      />
                    )}
                    {visibleMcpPage < maxMcpPage && (
                      <Button
                        key="mcp-next"
                        label="Next"
                        plain
                        onPress={() => {
                          mcpPage = Math.min(maxMcpPage, visibleMcpPage + 1)
                          $.ui.invalidate('ui.render')
                        }}
                      />
                    )}
                  </Box>
                </Box>

                {visibleMcpTools.map(tool => (
                  <Box key={`${tool.serverName}:${tool.name}`} flexDirection="column">
                    <Box justifyContent="space-between" width="100%" gap={1}>
                      <Text color={tool.isLoaded ? 'success' : 'inactive'} wrap="truncate">
                        {toolName(tool)}
                      </Text>
                      <Text dimColor>
                        {tool.isLoaded ? detailTokenLabel(tool.tokens) : 'deferred'}
                      </Text>
                    </Box>
                    {tool.isLoaded && (
                      progressBar(selectedServer.loadedTokens > 0
                        ? (tool.tokens / selectedServer.loadedTokens) * 100
                        : 0, shortBarWidth)
                    )}
                  </Box>
                ))}

                {selectedServer.deferredTools > 0 && (
                  <Text dimColor>
                    {selectedServer.deferredTools} deferred schemas are outside active context.
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}

        <Text dimColor>
          Messages is the conversation total. Per-message counts are not available.
        </Text>
        {breakdownError && <Text color="error">Last refresh failed: {breakdownError}</Text>}
      </Box>
    )
  })
}
