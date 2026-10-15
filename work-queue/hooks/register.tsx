import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'work-queue'
const CLOCK_INTERVAL_MS = 5_000
const CREATE_TOOL = 'mcp__work-queue__task_create'
const UPDATE_TOOL = 'mcp__work-queue__task_update'
const LIST_TOOL = 'mcp__work-queue__task_list'

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
type TaskGroup = 'Working' | 'Blocked' | 'Ready' | 'Done'
type TaskSource = 'work_queue' | 'claude'

type WorkTask = {
  id: string
  subject: string
  description: string
  activeForm: string
  status: TaskStatus
  owner: string
  blockedBy: string[]
  blocks: string[]
  source: TaskSource
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

type OwnedTaskCreateInput = {
  subject: string
  description?: string
  activeForm?: string
  owner?: string
  blockedBy?: string[]
}

type OwnedTaskUpdateInput = {
  taskId: string
  status?: Exclude<TaskStatus, 'deleted'>
  subject?: string
  description?: string
  activeForm?: string
  owner?: string
  blockedBy?: string[]
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__work-queue__task_create': OwnedTaskCreateInput
    'mcp__work-queue__task_update': OwnedTaskUpdateInput
    'mcp__work-queue__task_list': Record<string, unknown>
  }
}

const tasks = new Map<string, WorkTask>()
let selectedTaskId = ''
let currentTime = 0
let didAutoOpen = false
let showCompleted = false
let clockTimer: Timer | null = null
let nextTaskNumber = 1

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function resetState(): void {
  tasks.clear()
  selectedTaskId = ''
  currentTime = 0
  didAutoOpen = false
  showCompleted = false
  nextTaskNumber = 1
  clockTimer?.cancel()
  clockTimer = null
}

function ensureTask(
  id: string,
  now: number,
  subject = `Task ${id}`,
  source: TaskSource = 'claude',
): WorkTask {
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
    source,
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
    source: 'claude',
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

function inputRecord(event: unknown): Record<string, unknown> {
  return event && typeof event === 'object' ? event as Record<string, unknown> : {}
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

function stringListInput(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key]
  if (!Array.isArray(value)) return undefined
  return unique(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))
}

function publicTask(task: WorkTask): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    group: taskGroup(task),
    owner: task.owner,
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    source: task.source,
    editable: task.source === 'work_queue',
  }
}

function toolResult(value: Record<string, unknown>): { result: string } {
  return { result: JSON.stringify(value) }
}

function toolError(message: string): { deny: string } {
  return { deny: message }
}

function blockerError(taskId: string | undefined, blockedBy: string[]): string | null {
  if (taskId && blockedBy.includes(taskId)) {
    return `Task ${taskId} cannot block itself.`
  }

  const missing = blockedBy.find(id => {
    const blocker = tasks.get(id)
    return !blocker || blocker.status === 'deleted'
  })
  return missing ? `Blocking task ${missing} was not found.` : null
}

function setBlockedBy(task: WorkTask, blockedBy: string[]): void {
  for (const blockerId of task.blockedBy) {
    const blocker = tasks.get(blockerId)
    if (blocker) blocker.blocks = blocker.blocks.filter(id => id !== task.id)
  }

  task.blockedBy = unique(blockedBy.filter(id => id !== task.id))
  for (const blockerId of task.blockedBy) {
    const blocker = tasks.get(blockerId)
    if (blocker) blocker.blocks = unique([...blocker.blocks, task.id])
  }
}

async function createOwnedTask(
  $: EngineInterface,
  event: unknown,
): Promise<{ result: string } | { deny: string }> {
  const input = inputRecord(event)
  const subject = stringInput(input, 'subject')?.trim()
  if (!subject) {
    return toolError('A task subject is required.')
  }

  const blockedBy = stringListInput(input, 'blockedBy') ?? []
  const invalidBlocker = blockerError(undefined, blockedBy)
  if (invalidBlocker) return toolError(invalidBlocker)

  const now = await $.clock.now()
  currentTime = now
  let id = `queue-${nextTaskNumber++}`
  while (tasks.has(id)) id = `queue-${nextTaskNumber++}`
  const task = ensureTask(id, now, subject, 'work_queue')
  task.subject = subject
  task.description = stringInput(input, 'description')?.trim() ?? ''
  task.activeForm = stringInput(input, 'activeForm')?.trim() ?? ''
  task.owner = stringInput(input, 'owner')?.trim() ?? ''
  setBlockedBy(task, blockedBy)
  task.updatedAt = now
  changed($)

  return toolResult({ task: publicTask(task) })
}

async function updateOwnedTask(
  $: EngineInterface,
  event: unknown,
): Promise<{ result: string } | { deny: string }> {
  const input = inputRecord(event)
  const id = stringInput(input, 'taskId')?.trim()
  const task = id ? tasks.get(id) : undefined
  if (!task || task.status === 'deleted') {
    return toolError(`Task ${id || '(missing id)'} was not found.`)
  }
  if (task.source !== 'work_queue') {
    return toolError(`Task ${id} is managed by Claude's native task tools. Use TaskUpdate instead.`)
  }

  const blockedBy = stringListInput(input, 'blockedBy')
  const invalidBlocker = blockedBy ? blockerError(id, blockedBy) : null
  if (invalidBlocker) return toolError(invalidBlocker)

  const now = await $.clock.now()
  currentTime = now
  const subject = stringInput(input, 'subject')?.trim()
  const description = stringInput(input, 'description')
  const activeForm = stringInput(input, 'activeForm')
  const owner = stringInput(input, 'owner')
  const status = stringInput(input, 'status')

  if (subject) task.subject = subject
  if (description !== undefined) task.description = description.trim()
  if (activeForm !== undefined) task.activeForm = activeForm.trim()
  if (owner !== undefined) task.owner = owner.trim()
  if (blockedBy) setBlockedBy(task, blockedBy)
  if (status === 'pending' || status === 'in_progress' || status === 'completed') {
    setStatus(task, status, now)
  }
  task.updatedAt = now
  changed($)

  return toolResult({ task: publicTask(task) })
}

function listOwnedTasks(): { result: string } {
  return toolResult({
    tasks: [...tasks.values()]
      .filter(task => task.status !== 'deleted')
      .map(publicTask),
  })
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
    await $.tool.register({
      name: 'task_create',
      description: 'Add one concrete task to the Work Queue. Use this for substantive multi-step work and when the user asks for a task list. Returns the task id needed for dependencies and updates.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string', description: 'Short action-oriented task title.' },
          description: { type: 'string', description: 'What completing the task requires.' },
          activeForm: { type: 'string', description: 'Present-tense label shown while working.' },
          owner: { type: 'string', description: 'Optional owner or agent name.' },
          blockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task ids that must finish before this task can start.',
          },
        },
        required: ['subject'],
      },
    })
    await $.tool.register({
      name: 'task_update',
      description: 'Update a Work Queue task as work starts, changes, becomes blocked, or finishes. Keep the queue accurate while working.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', description: 'The Work Queue task id.' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: 'The task lifecycle state.',
          },
          subject: { type: 'string', description: 'Replacement task title.' },
          description: { type: 'string', description: 'Replacement task description.' },
          activeForm: { type: 'string', description: 'Present-tense label shown while working.' },
          owner: { type: 'string', description: 'Owner or agent name. Use an empty string to clear it.' },
          blockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: 'Complete replacement list of blocking task ids.',
          },
        },
        required: ['taskId'],
      },
    })
    await $.tool.register({
      name: 'task_list',
      description: 'Read the current Work Queue tasks, statuses, owners, and dependencies before planning or updating work.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    })
    clockTimer = $.clock.every(CLOCK_INTERVAL_MS, () => {
      void tickOpenPane($)
    })
    return next(event)
  })

  on('prompt.compose', async ($, event, next) => {
    const result = await next(event)
    if (event.traits.includes('teammate')) return result

    return {
      sections: [
        ...result.sections,
        {
          id: 'work-queue:workflow',
          scope: 'session',
          text: 'Use the Work Queue tools for substantive work with several concrete steps or whenever the user asks for a task list. Create the tasks before implementation, mark the current task in progress, keep blockers accurate, and complete each task when it is actually done. Do not create queue tasks for simple questions or one-step actions.',
        },
      ],
    }
  }).catch(($, event, next) => next(event))

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
    if (event.tool === CREATE_TOOL) return createOwnedTask($, event)
    if (event.tool === UPDATE_TOOL) return updateOwnedTask($, event)
    if (event.tool === LIST_TOOL) return listOwnedTasks()

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
  }).catch(($, event, next) => {
    if (event.tool === CREATE_TOOL || event.tool === UPDATE_TOOL || event.tool === LIST_TOOL) {
      return toolError('Work Queue could not update the task list.')
    }
    return next(event)
  })

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

    const sessionTasks = [...tasks.values()].filter(task => task.status !== 'deleted')
    const openTasks = sessionTasks.filter(task => task.status !== 'completed')
    const doneCount = sessionTasks.length - openTasks.length
    const visibleTasks = showCompleted ? sessionTasks : openTasks
    const openCount = openTasks.length
    const groups: TaskGroup[] = ['Working', 'Blocked', 'Ready', 'Done']

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" width="100%">
          <Text bold>Work Queue</Text>
          <Box gap={1}>
            {sessionTasks.length > 0 && <Text dimColor>{openCount} open</Text>}
            {doneCount > 0 && (
              <Button
                key="toggle-completed"
                label={`${showCompleted ? 'Hide' : 'Show'} ${doneCount} done`}
                plain
                dimColor
                onPress={() => {
                  showCompleted = !showCompleted
                  $.ui.invalidate('ui.render')
                }}
              />
            )}
          </Box>
        </Box>

        {sessionTasks.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No tasks in this session.</Text>
            <Text dimColor>Ask Claude to break substantive work into tasks.</Text>
          </Box>
        ) : openCount === 0 && !showCompleted ? (
          <Text dimColor>All tasks completed.</Text>
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
