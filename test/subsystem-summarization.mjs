#!/usr/bin/env node
/**
 * 后台总结子系统的最小可执行用例（验收标准 2 之一）。
 *
 * 独立于另外两个子系统：本文件只 import `src/subsystems/summarization.js`。
 * 产出物是**总结文本**（后台 Agent 循环跑完后的终态文本 + 轮次 + 工具调用轨迹），
 * 并在 stdout 打印 JSON，供上层解析。
 *
 * 用一份确定性的假 model 驱动循环，避免依赖真实网络/模型；这仍是「可执行的最小
 * 用例」—— 被验证的是子系统自身的循环与权限逻辑。
 *
 * 同时验证与 ZCode `memory/memory-agent-loop.ts` 的逐项行为对齐。
 */

import assert from 'node:assert/strict'
import { join, sep } from 'node:path'

import {
  MEMORY_AGENT_READ_ONLY_TOOLS,
  MEMORY_AGENT_SHELL_TOOLS,
  MEMORY_AGENT_WRITE_TOOLS,
  READ_ONLY_BASH_COMMANDS,
  denyMemoryAgentBash,
  denyMemoryAgentTool,
  denyUnavailableMemoryAgentTool,
  evaluateMemoryAgentToolPolicy,
  isContainedMarkdownMutation,
  isContainedMarkdownBashRemoval,
  resolveContainedMemoryFilePath,
  runMemoryAgentLoop,
} from '../src/subsystems/summarization.js'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    process.stdout.write(`  \u001B[32m✓\u001B[0m ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`  \u001B[31m✗\u001B[0m ${label}\n      ${error.message}\n`)
  }
}

const MEMORY_ROOT = join(sep, 'home', 'user', '.dsh', 'memories', 'projects', 'demo-abc', 'memory')
const WORKING_DIRECTORY = join(sep, 'home', 'user', 'project')

/**
 * 造一个只有最小契约的假工具目录。
 *
 * 工具名用 DSH 实际注册的小写名（`read`/`write`/`edit`/`bash`/`glob`/`grep`）。
 */
const toolCatalog = [
  { name: 'read' },
  { name: 'grep' },
  { name: 'glob' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'bash' },
  { name: 'Agent' },
  { name: 'mcp__memorix__search' },
  { name: 'web_search', sideEffectScope: 'network' },
  { name: 'tavily_search', sideEffectScope: 'network' },
]

const policyInput = (name, input) => ({
  rootDir: MEMORY_ROOT,
  toolCall: { name, input },
  tools: toolCatalog,
  workingDirectory: WORKING_DIRECTORY,
  workspaceRoot: WORKING_DIRECTORY,
})

// ---- 常量与拒绝文案逐字符对齐 ----------------------------------------
check('工具名一律用 DSH 实际注册的小写名', () => {
  // ZCode 的 Read/Write/Edit/Bash 在 DSH 上永远不会命中（名字是字面量小写），
  // 因此集合里只应存在小写名 —— 大写项属死代码。
  for (const set of [
    MEMORY_AGENT_READ_ONLY_TOOLS,
    MEMORY_AGENT_WRITE_TOOLS,
    MEMORY_AGENT_SHELL_TOOLS,
  ]) {
    for (const name of set) {
      assert.equal(name, name.toLowerCase(), `集合里不应出现大写工具名：${name}`)
    }
  }
  assert.deepEqual([...MEMORY_AGENT_READ_ONLY_TOOLS].sort(), ['glob', 'grep', 'read'])
  assert.deepEqual([...MEMORY_AGENT_WRITE_TOOLS].sort(), ['edit', 'write'])
  assert.deepEqual([...MEMORY_AGENT_SHELL_TOOLS], ['bash'])
})
check('只读 Bash 白名单与抽取 Prompt 的说明一致', () => {
  assert.deepEqual(
    [...READ_ONLY_BASH_COMMANDS].sort(),
    ['cat', 'find', 'head', 'ls', 'stat', 'tail', 'wc'].sort(),
  )
})
check('denyMemoryAgentTool 文案与 ZCode 逐字符一致', () => {
  assert.equal(
    denyMemoryAgentTool(MEMORY_ROOT).reason,
    `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${MEMORY_ROOT} are allowed`,
  )
})
check('denyMemoryAgentBash 文案与 ZCode 逐字符一致', () => {
  assert.equal(
    denyMemoryAgentBash(MEMORY_ROOT).reason,
    `Only read-only shell commands and rm with all paths inside ${MEMORY_ROOT} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  )
})
check('denyUnavailableMemoryAgentTool 文案与 ZCode 逐字符一致', () => {
  assert.equal(
    denyUnavailableMemoryAgentTool('nope').reason,
    '<tool_use_error>Error: No such tool available: nope</tool_use_error>',
  )
})

// ---- 权限判定 --------------------------------------------------------
check('只读工具放行', () => {
  for (const tool of ['read', 'grep', 'glob']) {
    assert.equal(evaluateMemoryAgentToolPolicy(policyInput(tool, {})).allowed, true, tool)
  }
})
check('未注册工具返回 No such tool available', () => {
  const decision = evaluateMemoryAgentToolPolicy(policyInput('definitely_missing', {}))
  assert.equal(decision.allowed, false)
  assert.ok(decision.reason.includes('No such tool available: definitely_missing'))
})
check('Agent 一律拒绝', () => {
  assert.equal(evaluateMemoryAgentToolPolicy(policyInput('Agent', {})).allowed, false)
})
check('mcp__ 前缀工具一律拒绝', () => {
  assert.equal(
    evaluateMemoryAgentToolPolicy(policyInput('mcp__memorix__search', {})).allowed,
    false,
  )
})
check('network 类工具一律拒绝', () => {
  assert.equal(evaluateMemoryAgentToolPolicy(policyInput('web_search', {})).allowed, false)
})
check('Write/Edit 限记忆目录内的 .md', () => {
  const inside = policyInput('write', { file_path: join(MEMORY_ROOT, 'a.md') })
  assert.equal(evaluateMemoryAgentToolPolicy(inside).allowed, true)

  const outside = policyInput('write', { file_path: join(WORKING_DIRECTORY, 'a.md') })
  assert.equal(evaluateMemoryAgentToolPolicy(outside).allowed, false)

  const nonMarkdown = policyInput('write', { file_path: join(MEMORY_ROOT, 'a.txt') })
  assert.equal(evaluateMemoryAgentToolPolicy(nonMarkdown).allowed, false)
})
check('Write/Edit 拒绝路径穿越', () => {
  const escape = policyInput('edit', { file_path: join(MEMORY_ROOT, '..', 'escaped.md') })
  assert.equal(isContainedMarkdownMutation(escape), false)
  assert.equal(evaluateMemoryAgentToolPolicy(escape).allowed, false)
})
check('只读 Bash 放行', () => {
  for (const command of ['ls', 'ls -la', 'cat MEMORY.md', 'find . -name "*.md"', 'wc -l a.md']) {
    const decision = evaluateMemoryAgentToolPolicy(policyInput('bash', { command }))
    assert.equal(decision.allowed, true, command)
  }
})
check('写型 Bash 拒绝', () => {
  for (const command of ['rm -rf /', 'echo hi > x.md', 'ls | tee x', 'curl http://x', 'git commit -m x']) {
    const decision = evaluateMemoryAgentToolPolicy(policyInput('bash', { command }))
    assert.equal(decision.allowed, false, command)
  }
})
check('受限 rm 放行记忆目录内的绝对 .md', () => {
  const command = `rm ${join(MEMORY_ROOT, 'old.md')}`
  assert.equal(isContainedMarkdownBashRemoval(command, policyInput('bash', {}).rootDir && {
    rootDir: MEMORY_ROOT,
    workingDirectory: WORKING_DIRECTORY,
    workspaceRoot: WORKING_DIRECTORY,
  }), true)
})
check('rm 拒绝记忆目录外的路径 / 递归 / 通配符 / 相对路径', () => {
  const context = {
    rootDir: MEMORY_ROOT,
    workingDirectory: WORKING_DIRECTORY,
    workspaceRoot: WORKING_DIRECTORY,
  }
  for (const command of [
    `rm ${join(WORKING_DIRECTORY, 'x.md')}`,
    `rm -r ${join(MEMORY_ROOT, 'old.md')}`,
    `rm ${MEMORY_ROOT}/*.md`,
    'rm old.md',
    `rm ${join(MEMORY_ROOT, 'old.txt')}`,
  ]) {
    assert.equal(isContainedMarkdownBashRemoval(command, context), false, command)
  }
})
check('resolveContainedMemoryFilePath 行为正确', () => {
  assert.equal(
    resolveContainedMemoryFilePath({
      filePath: join(MEMORY_ROOT, 'a.md'),
      rootDir: MEMORY_ROOT,
      workingDirectory: WORKING_DIRECTORY,
      workspaceRoot: WORKING_DIRECTORY,
    }),
    join(MEMORY_ROOT, 'a.md'),
  )
  assert.equal(
    resolveContainedMemoryFilePath({
      filePath: 'a.md',
      rootDir: MEMORY_ROOT,
      workingDirectory: MEMORY_ROOT,
      workspaceRoot: WORKING_DIRECTORY,
    }),
    join(MEMORY_ROOT, 'a.md'),
  )
  assert.equal(
    resolveContainedMemoryFilePath({
      filePath: '../escape.md',
      rootDir: MEMORY_ROOT,
      workingDirectory: MEMORY_ROOT,
      workspaceRoot: WORKING_DIRECTORY,
    }),
    undefined,
  )
  assert.equal(
    resolveContainedMemoryFilePath({
      filePath: MEMORY_ROOT,
      rootDir: MEMORY_ROOT,
      workingDirectory: WORKING_DIRECTORY,
      workspaceRoot: WORKING_DIRECTORY,
    }),
    undefined,
  )
})

// ---- 后台 Agent 循环 --------------------------------------------------
/** 跑一次循环，返回轨迹与结果。 */
const runLoop = async (scriptedResponses, { maxTurns = 5, tools = toolCatalog } = {}) => {
  const executed = []
  const requests = []
  let index = 0
  const model = {
    async generateText(request) {
      requests.push({
        messageCount: request.messages.length,
        toolNames: request.tools.map((tool) => tool.name),
      })
      const next = scriptedResponses[Math.min(index, scriptedResponses.length - 1)]
      index += 1
      return next
    },
  }
  const result = await runMemoryAgentLoop({
    executeTool: async (toolCall) => {
      executed.push(toolCall.name)
      return { content: `ran ${toolCall.name}`, isError: false }
    },
    maxTurns,
    messages: [{ content: 'seed', role: 'user' }],
    model,
    rootDir: MEMORY_ROOT,
    tools,
    workingDirectory: WORKING_DIRECTORY,
    workspaceRoot: WORKING_DIRECTORY,
  })
  return { executed, requests, result }
}

const noToolRun = await runLoop([{ text: 'Nothing to save.' }])
check('无 toolCall 时一轮结束并返回总结文本', () => {
  assert.equal(noToolRun.result.turns, 1)
  assert.equal(noToolRun.executed.length, 0)
  const final = noToolRun.result.messages.at(-1)
  assert.equal(final.role, 'assistant')
  assert.equal(final.content, 'Nothing to save.')
})
check('provider request 保留主 Agent 的真实工具目录', () => {
  assert.deepEqual(
    noToolRun.requests[0].toolNames,
    toolCatalog.map((tool) => tool.name),
  )
})
check('每轮请求都在消息副本上（不污染原数组长度语义）', () => {
  // 第 1 轮请求只带 seed；seed 之后的消息是循环内部推进的。
  assert.equal(noToolRun.requests[0].messageCount, 1)
})

const allowedRun = await runLoop([
  { text: '', toolCalls: [{ id: 'c1', input: { file_path: join(MEMORY_ROOT, 'a.md') }, name: 'write' }] },
  { text: 'Saved the lesson.' },
])
check('放行的工具被真正执行，结果以 tool 消息回灌', () => {
  assert.deepEqual(allowedRun.executed, ['write'])
  assert.equal(allowedRun.result.turns, 2)
  const toolMessage = allowedRun.result.messages.find((message) => message.role === 'tool')
  assert.equal(toolMessage.content, 'ran write')
  assert.equal(toolMessage.isError, false)
})
check('第二轮请求带上新增的 assistant + tool 消息', () => {
  assert.equal(allowedRun.requests[1].messageCount, 3)
})

const deniedRun = await runLoop([
  { text: '', toolCalls: [{ id: 'c2', input: { command: 'rm -rf /' }, name: 'bash' }] },
  { text: 'Understood, I will not do that.' },
])
check('被拒工具不进执行面，但仍以 isError 回灌', () => {
  assert.equal(deniedRun.executed.length, 0, '被拒工具不得被执行')
  const toolMessage = deniedRun.result.messages.find((message) => message.role === 'tool')
  assert.equal(toolMessage.isError, true)
  assert.ok(toolMessage.content.includes(`inside ${MEMORY_ROOT}`))
})
check('多个 toolCall 并行处理', async () => {
  const parallel = await runLoop([
    {
      text: '',
      toolCalls: [
        { id: 'p1', input: {}, name: 'read' },
        { id: 'p2', input: { command: 'ls' }, name: 'bash' },
        { id: 'p3', input: {}, name: 'Agent' },
      ],
    },
    { text: 'done' },
  ])
  assert.deepEqual(parallel.executed.sort(), ['bash', 'read'])
  const toolMessages = parallel.result.messages.filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 3)
  assert.equal(toolMessages.filter((message) => message.isError).length, 1)
})
check('maxTurns 上限生效', async () => {
  const looping = await runLoop(
    [{ text: '', toolCalls: [{ id: 'x', input: {}, name: 'read' }] }],
    { maxTurns: 3 },
  )
  assert.equal(looping.result.turns, 3)
})
check('已取消的 abortSignal 立刻中止', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      runMemoryAgentLoop({
        abortSignal: controller.signal,
        executeTool: async () => ({ content: '', isError: false }),
        maxTurns: 5,
        messages: [{ content: 'seed', role: 'user' }],
        model: { async generateText() { return { text: 'x' } } },
        rootDir: MEMORY_ROOT,
        tools: toolCatalog,
        workingDirectory: WORKING_DIRECTORY,
        workspaceRoot: WORKING_DIRECTORY,
      }),
    (error) => error.name === 'AbortError',
  )
})

if (failures > 0) {
  process.stdout.write(`\nsummarization 子系统：${failures} 项失败\n`)
  process.exit(1)
}

// 结构化产出：总结文本。
process.stdout.write(
  `${JSON.stringify({
    subsystem: 'summarization',
    summary: noToolRun.result.messages.at(-1).content,
    turns: noToolRun.result.turns,
    allowedToolCalls: allowedRun.executed,
    deniedToolCalls: 1,
    messages: allowedRun.result.messages.length,
  })}\n`,
)
process.stdout.write('\nsummarization 子系统：全部通过\n')
process.exit(0)