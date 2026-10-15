import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'work-queue'
const CLOCK_INTERVAL_MS = 5_000

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
type TaskGroup = 'Working' | 'Blocked' | 'Ready' | 'Done'

type WorkTask = {
  id: string
  subject: string
  description: string
  activeForm: string
  status: TaskStatus
  owner: string
  blockedBy: string[]
  blocks: string[]
  createdAt: number
  updatedAt: number
  statusChangedAt: number
}

type TaskListItem = {
  id: string
  subject: string
  status: Exclude<TaskStatus, 'deleted'>
  owner?: string
  blockedBy: string[]
}

type TaskDetail = {
  id: string
  subject: string
  description: string
  status: Exclude<TaskStatus, 'deleted'>
  blocks: string[]
  blockedBy: string[]
}

const tasks = new Map<string, WorkTask>()
let selectedTaskId = ''
let currentTime = 0
let didAutoOpen = false
let clockTimer: Timer | null = null

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function resetState(): void {
  tasks.clear()
  selectedTaskId = ''
  currentTime = 0
  didAutoOpen = false
  clockTimer?.cancel()
  clockTimer = null
}

function ensureTask(id: string, now: number, subject = `Task ${id}`): WorkTask {
  const existing = tasks.get(id)
  if (existing) return existing

  const task: WorkTask = {
    id,
    subject,
    description: '',
    activeForm: '',
    status: 'pending',
    owner: '',
    blockedBy: [],
    blocks: [],
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
  }
  tasks.set(id, task)
  return task
}

function setStatus(task: WorkTask, status: TaskStatus, now: number): void {
  if (task.status === status) return
  task.status = status
  task.statusChangedAt = now
  task.updatedAt = now
}

function isBlocked(task: WorkTask): boolean {
  if (task.status !== 'pending') return false
  return task.blockedBy.some(id => tasks.get(id)?.status !== 'completed')
}

function taskGroup(task: WorkTask): TaskGroup {
  if (task.status === 'completed') return 'Done'
  if (task.status === 'in_progress') return 'Working'
  if (isBlocked(task)) return 'Blocked'
  return 'Ready'
}

function groupColor(group: TaskGroup): 'success' | 'warning' | 'accent' | 'inactive' {
  if (group === 'Working') return 'success'
  if (group === 'Blocked') return 'warning'
  if (group === 'Ready') return 'accent'
  return 'inactive'
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function taskAge(task: WorkTask): string {
  if (task.status === 'in_progress') {
    return durationLabel(currentTime - task.statusChangedAt)
  }
  if (task.status === 'completed') {
    return `${durationLabel(currentTime - task.updatedAt)} ago`
  }
  return durationLabel(currentTime - task.createdAt)
}

function taskMeta(task: WorkTask, group: TaskGroup): string {
  const parts = task.owner ? [task.owner] : []
  if (group === 'Blocked') {
    const count = task.blockedBy.length
    parts.push(`${count} blocker${count === 1 ? '' : 's'}`)
  }
  return parts.join('  ') || 'Unassigned'
}

function taskReference(id: string): WorkTask {
  return tasks.get(id) ?? {
    id,
    subject: `Task ${id}`,
    description: '',
    activeForm: '',
    status: 'pending',
    owner: '',
    blockedBy: [],
    blocks: [],
    createdAt: currentTime,
    updatedAt: currentTime,
    statusChangedAt: currentTime,
  }
}

function taskCreateResult(value: unknown): { id: string; subject: string } | null {
  if (!value || typeof value !== 'object' || !('task' in value)) return null
  const task = value.task
  if (!task || typeof task !== 'object') return null
  if (!('id' in task) || typeof task.id !== 'string') return null
  if (!('subject' in task) || typeof task.subject !== 'string') return null
  return { id: task.id, subject: task.subject }
}

function taskUpdateSucceeded(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'success' in value && value.success === true)
}

function taskListResult(value: unknown): TaskListItem[] | null {
  if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) {
    return null
  }

  const items: TaskListItem[] = []
  for (const item of value.tasks) {
    if (!item || typeof item !== 'object') continue
    if (!('id' in item) || typeof item.id !== 'string') continue
    if (!('subject' in item) || typeof item.subject !== 'string') continue
    if (!('status' in item) || (
      item.status !== 'pending'
      && item.status !== 'in_progress'
      && item.status !== 'completed'
    )) continue

    items.push({
      id: item.id,
      subject: item.subject,
      status: item.status,
      owner: 'owner' in item && typeof item.owner === 'string' ? item.owner : undefined,
      blockedBy: 'blockedBy' in item && Array.isArray(item.blockedBy)
        ? item.blockedBy.filter((id: unknown): id is string => typeof id === 'string')
        : [],
    })
  }
  return items
}

function taskDetailResult(value: unknown): TaskDetail | null {
  if (!value || typeof value !== 'object' || !('task' in value)) return null
  const task = value.task
  if (!task || typeof task !== 'object') return null
  if (!('id' in task) || typeof task.id !== 'string') return null
  if (!('subject' in task) || typeof task.subject !== 'string') return null
  if (!('description' in task) || typeof task.description !== 'string') return null
  if (!('status' in task) || (
    task.status !== 'pending'
    && task.status !== 'in_progress'
    && task.status !== 'completed'
  )) return null

  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blocks: 'blocks' in task && Array.isArray(task.blocks)
      ? task.blocks.filter(id => typeof id === 'string')
      : [],
    blockedBy: 'blockedBy' in task && Array.isArray(task.blockedBy)
      ? task.blockedBy.filter(id => typeof id === 'string')
      : [],
  }
}

function maybeOpen($: EngineInterface): void {
  if (didAutoOpen || tasks.size === 0) return
  didAutoOpen = true
  void $.ui.open({ id: PANE, title: 'Tasks', columns: 58 })
}

function changed($: EngineInterface): void {
  maybeOpen($)
  $.ui.invalidate('ui.render')
}

async function tickOpenPane($: EngineInterface): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(item => item.id === PANE)
    if (!pane?.isPlaced || !pane.isShown) return
    currentTime = await $.clock.now()
    $.ui.invalidate('ui.render')
  } catch {
    // A display refresh should never affect Claude's work.
  }
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    resetState()
    await $.command.register({
      name: 'work-queue',
      description: 'Open the current Claude task queue',
    })
    clockTimer = $.clock.every(CLOCK_INTERVAL_MS, () => {
      void tickOpenPane($)
    })
    return next(event)
  })

  on('session.end', ($, event, next) => {
    clockTimer?.cancel()
    clockTimer = null
    return next(event)
  })

  on('command.run', { command: 'work-queue' }, async $ => {
    await $.ui.open({
      id: PANE,
      title: 'Tasks',
      focus: true,
      closeOnEscape: true,
      columns: 58,
    })
    currentTime = await $.clock.now()
    $.ui.invalidate('ui.render')
    return { text: 'Work queue opened.' }
  }).catch(() => ({ text: 'Work Queue could not open the task pane.' }))

  on('classic.TaskCreated', async ($, event, next) => {
    const result = await next(event)
    const now = await $.clock.now()
    currentTime = now
    const task = ensureTask(event.task_id, now, event.task_subject)
    task.subject = event.task_subject
    task.description = event.task_description ?? task.description
    task.owner = event.teammate_name ?? task.owner
    task.updatedAt = now
    changed($)
    return result
  }).catch(($, event, next) => next(event))

  on('classic.TaskCompleted', async ($, event, next) => {
    const result = await next(event)
    const now = await $.clock.now()
    currentTime = now
    const task = ensureTask(event.task_id, now, event.task_subject)
    task.subject = event.task_subject
    task.description = event.task_description ?? task.description
    task.owner = event.teammate_name ?? task.owner
    setStatus(task, 'completed', now)
    changed($)
    return result
  }).catch(($, event, next) => next(event))

  on('tool.call', async ($, event, next) => {
    const result = await next(event)
    if (result.isError || result.deny) return result

    const now = await $.clock.now()
    currentTime = now

    if (event.tool === 'TaskCreate') {
      const created = taskCreateResult(result.result)
      if (!created) return result

      const task = ensureTask(created.id, now, created.subject)
      task.subject = event.subject || created.subject
      task.description = event.description
      task.activeForm = event.activeForm ?? ''
      task.updatedAt = now
      changed($)
    }

    if (event.tool === 'TaskUpdate') {
      if (!taskUpdateSucceeded(result.result)) return result

      const task = ensureTask(event.taskId, now)
      if (event.subject !== undefined) task.subject = event.subject
      if (event.description !== undefined) task.description = event.description
      if (event.activeForm !== undefined) task.activeForm = event.activeForm
      if (event.owner !== undefined) task.owner = event.owner
      if (event.addBlockedBy) {
        task.blockedBy = unique([...task.blockedBy, ...event.addBlockedBy])
        for (const blockerId of event.addBlockedBy) {
          const blocker = ensureTask(blockerId, now)
          blocker.blocks = unique([...blocker.blocks, task.id])
        }
      }
      if (event.addBlocks) {
        task.blocks = unique([...task.blocks, ...event.addBlocks])
        for (const blockedId of event.addBlocks) {
          const blocked = ensureTask(blockedId, now)
          blocked.blockedBy = unique([...blocked.blockedBy, task.id])
        }
      }
      task.updatedAt = now
      if (event.status) setStatus(task, event.status, now)
      changed($)
    }

    if (event.tool === 'TaskList') {
      const listed = taskListResult(result.result)
      if (!listed) return result

      for (const item of listed) {
        const task = ensureTask(item.id, now, item.subject)
        const before = JSON.stringify([task.subject, task.owner, task.blockedBy, task.status])
        task.subject = item.subject
        task.owner = item.owner ?? ''
        task.blockedBy = item.blockedBy
        setStatus(task, item.status, now)
        if (before !== JSON.stringify([task.subject, task.owner, task.blockedBy, task.status])) {
          task.updatedAt = now
        }
      }
      changed($)
    }

    if (event.tool === 'TaskGet') {
      const detail = taskDetailResult(result.result)
      if (!detail) return result

      const task = ensureTask(detail.id, now, detail.subject)
      const before = JSON.stringify([
        task.subject,
        task.description,
        task.blocks,
        task.blockedBy,
        task.status,
      ])
      task.subject = detail.subject
      task.description = detail.description
      task.blocks = detail.blocks
      task.blockedBy = detail.blockedBy
      setStatus(task, detail.status, now)
      if (before !== JSON.stringify([
        task.subject,
        task.description,
        task.blocks,
        task.blockedBy,
        task.status,
      ])) task.updatedAt = now
      changed($)
    }

    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Text } = $.ui.resolve(event)
    const selected = selectedTaskId ? tasks.get(selectedTaskId) : undefined

    if (selected && selected.status !== 'deleted') {
      const group = taskGroup(selected)
      const blockedBy = selected.blockedBy.map(taskReference)
      const blocks = selected.blocks.map(taskReference)

      return (
        <Box flexDirection="column" gap={1}>
          <Button
            key="work-back"
            label="Back"
            plain
            onPress={() => {
              selectedTaskId = ''
              $.ui.invalidate('ui.render')
            }}
          />

          <Box flexDirection="column">
            <Box justifyContent="space-between" width="100%">
              <Text bold wrap="wrap">{selected.subject}</Text>
              <Text color={groupColor(group)}>{group}</Text>
            </Box>
            {selected.description && <Text dimColor wrap="wrap">{selected.description}</Text>}
          </Box>

          <Box flexDirection="column">
            <Text dimColor>Owner: {selected.owner || 'Unassigned'}</Text>
            <Text dimColor>Created {durationLabel(currentTime - selected.createdAt)} ago</Text>
            <Text dimColor>Updated {durationLabel(currentTime - selected.updatedAt)} ago</Text>
          </Box>

          {blockedBy.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Blocked by</Text>
              {blockedBy.map(task => (
                <Button
                  key={`dependency:${task.id}`}
                  plain
                  dimColor
                  onPress={() => {
                    selectedTaskId = task.id
                    $.ui.invalidate('ui.render')
                  }}
                >
                  {task.subject}
                </Button>
              ))}
            </Box>
          )}

          {blocks.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Blocks</Text>
              {blocks.map(task => (
                <Button
                  key={`dependent:${task.id}`}
                  plain
                  dimColor
                  onPress={() => {
                    selectedTaskId = task.id
                    $.ui.invalidate('ui.render')
                  }}
                >
                  {task.subject}
                </Button>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const visibleTasks = [...tasks.values()].filter(task => task.status !== 'deleted')
    const openCount = visibleTasks.filter(task => task.status !== 'completed').length
    const doneCount = visibleTasks.length - openCount
    const groups: TaskGroup[] = ['Working', 'Blocked', 'Ready', 'Done']

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" width="100%">
          <Text bold>Work Queue</Text>
          {visibleTasks.length > 0 && <Text dimColor>{openCount} open  {doneCount} done</Text>}
        </Box>

        {visibleTasks.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No tasks in this session.</Text>
            <Text dimColor>The queue updates when Claude creates a task.</Text>
          </Box>
        ) : groups.map(group => {
          const groupTasks = visibleTasks
            .filter(task => taskGroup(task) === group)
            .sort((left, right) => left.createdAt - right.createdAt)
          if (groupTasks.length === 0) return null

          return (
            <Box key={`group:${group}`} flexDirection="column">
              <Box gap={1}>
                <Text color={groupColor(group)}>●</Text>
                <Text bold>{group}</Text>
                <Text dimColor>{groupTasks.length}</Text>
              </Box>

              <Box flexDirection="column" marginLeft={2}>
                {groupTasks.map(task => (
                  <Box key={`task:${task.id}`} flexDirection="column" marginBottom={1}>
                    <Box justifyContent="space-between" alignItems="center" width="100%">
                      <Text wrap="truncate">{task.subject}</Text>
                      <Button
                        key={`task-view:${task.id}`}
                        label="View"
                        plain
                        dimColor
                        onPress={() => {
                          selectedTaskId = task.id
                          $.ui.invalidate('ui.render')
                        }}
                      />
                    </Box>
                    <Box justifyContent="space-between" width="100%">
                      <Text dimColor wrap="truncate">
                        {taskMeta(task, group)}
                      </Text>
                      <Text dimColor>{taskAge(task)}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
