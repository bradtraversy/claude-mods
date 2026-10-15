import type { Register } from 'claude-code'

const PANE = 'impact-map'
const files = new Map<string, 'read' | 'edited' | 'created'>()

function remember(path: string, action: 'read' | 'edited' | 'created'): void {
  files.delete(path)
  files.set(path, action)
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'impact-map',
      description: 'Open the workspace impact map',
    })
    void $.ui.open({ id: PANE, title: 'Impact Map' })
    return next(event)
  })

  on('command.run', { command: 'impact-map' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Impact Map', focus: true })
    return { text: 'Workspace impact map opened.' }
  })

  on('tool.call', async ($, event, next) => {
    const result = await next(event)

    if (event.tool === 'Read') remember(event.file_path, 'read')
    if (event.tool === 'Edit') remember(event.file_path, 'edited')
    if (event.tool === 'Write') remember(event.file_path, 'created')

    if (event.tool === 'Read' || event.tool === 'Edit' || event.tool === 'Write') {
      $.ui.invalidate('ui.render')
    }

    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Text } = $.ui.resolve(event)
    const entries = [...files.entries()].slice(-14)

    if (entries.length === 0) return <Text dimColor>No files touched yet.</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{entries.length} recent files</Text>
        <Box flexDirection="column">
          {entries.map(([path, action]) => (
            <Box key={path} gap={1}>
              <Text color={action === 'read' ? 'accent' : action === 'edited' ? 'warning' : 'success'}>
                {action.toUpperCase().padEnd(7)}
              </Text>
              <Text wrap="truncate">{path}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
