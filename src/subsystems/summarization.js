/**
 * 后台总结子系统 —— ZCode `memory/memory-agent-loop.ts` 的完整复刻。
 *
 * ZCode 的后台总结不是一个「单次 Prompt 让模型吐一段摘要」的调用，而是一个**独立的
 * 轻量级伴生 Agent 循环**：它带着主 Agent 的真实工具目录跑若干轮，但**执行权限在
 * tool-use 边界被收窄**到「只读 + 仅限记忆目录内的写入」。这个子系统复刻的就是这个
 * 循环 + 那套权限判定。
 *
 * 与 ZCode 的对应关系（出处：`apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts`）：
 *
 * | 行为 | ZCode 出处 |
 * |---|---|
 * | `runMemoryAgentLoop({…})` | 同名函数 |
 * | `maxTurns` 上限与 `turns` 计数 | 循环头 |
 * | 每轮先建 request-local 消息副本 | `cloneModelMessage` |
 * | 无 toolCall 即结束 | `if (toolCalls.length === 0)` |
 * | 工具目录**保留主 Agent 全集** | `tools: input.tools` 注释 |
 * | 权限判定 `evaluateMemoryAgentToolPolicy` | 同名函数 |
 * | 拒绝结果以 `isError` 回灌下一轮 | `decision.allowed === false` 分支 |
 * | catalog miss → `No such tool available` | `denyUnavailableMemoryAgentTool` |
 * | `Agent`/`mcp__*`/network 一律拒 | 策略头部 |
 * | `write`/`edit` 仅限记忆目录内 `.md` | `isContainedMarkdownMutation` |
 * | `bash` 仅只读或受限 `rm` | `isRuntimeReadOnlyBashCommand`/`isContainedMarkdownBashRemoval` |
 * | 只读工具白名单 `read`/`grep`/`glob` | `MEMORY_AGENT_READ_ONLY_TOOLS` |
 * | 两类固定拒绝文案 | `denyMemoryAgentBash`/`denyMemoryAgentTool` |
 *
 * 刻意的差异（DSH 侧没有 ZCode 的 Bash 语义分析器与工具契约类型）：
 *   - ZCode 的 Bash 判定复用 `analyzeBashCommand` + `isRuntimeReadOnlyBashCommand`
 *     （数百行的命令解析器）。DSH 侧不存在这个模块，且「不引入文档未提及的第三方
 *     依赖」与「最小改动」都禁止我搬运它。这里按 ZCode **同一个判定意图**做保守的
 *     白名单实现：只在一个明确的只读命令集合内放行，其余一律拒绝 —— 方向是
 *     「宁可多拒」，与 ZCode 「All other tools … will be denied」的取向一致。
 *   - 工具契约的 `sideEffectScope === 'network'` 在 DSH 侧没有等价字段，因此
 *     network 类工具改为按工具名（`mcp__` 前缀）与 `Agent` 名判定。
 *
 * 该子系统可单独启用、单独调用：`runMemoryAgentLoop` 的全部依赖（model、tools、
 * executeTool）都由参数注入，它不 import 另外两个子系统。
 *
 * @module dsh-zcode-project-memory/subsystems/summarization
 */

import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

/**
 * 后台总结 Agent 允许使用的只读工具。
 *
 * 出处（语义）：ZCode `memory-agent-loop.ts` `const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"])`。
 *
 * 命名：ZCode 用首字母大写，但 **DSH 注册的名字是字面量小写** —— `dsh-tool-fs` 的
 * `ctx.tools.register(defineTool({ name: "read" }))` 等，名字不从配置派生。因此这里
 * 只用 DSH 实际生效的小写名；大写名在 DSH 上永远不会命中，属死代码，已删除。
 */
export const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob'])

/**
 * 后台总结 Agent 视为「写入工具」的名字集合。
 *
 * 出处（语义）：ZCode `memory/memory-agent-loop.ts` 的 `Write`/`Edit` 分支。
 * 命名：用 DSH 实际注册的小写名（`dsh-tool-fs` 注册 `write`/`edit`）。
 */
export const MEMORY_AGENT_WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * 后台总结 Agent 视为「shell」的名字集合。
 *
 * 出处（语义）：ZCode `memory/memory-agent-loop.ts` 的 `Bash` 分支。
 * 命名：用 DSH 实际注册的小写名（`dsh-tool-bash` 注册 `bash`）。
 */
export const MEMORY_AGENT_SHELL_TOOLS = new Set(['bash'])

/**
 * 后台总结 Agent 允许执行的只读 Bash 子命令。
 *
 * 出处：ZCode 复用的 `isRuntimeReadOnlyBashCommand`（只读分类器）与
 * `buildMemoryExtractionPrompt` 里的工具说明 "read-only Bash (ls/find/cat/stat/wc/head/tail
 * and similar)"。这里取该说明里显式列举的命令作为白名单，是最贴近文档字面的路径。
 */
export const READ_ONLY_BASH_COMMANDS = new Set([
  'ls',
  'find',
  'cat',
  'stat',
  'wc',
  'head',
  'tail',
])

/**
 * `find` 的写入选项。
 *
 * 出处：ZCode `bash-readonly-policy-argv-direct.ts` `FIND_WRITE_OPTIONS`（逐项对齐）。
 * 只读白名单里的其它命令没有等价的多态写入选项，所以只需对 `find` 做这一层检查。
 */
export const FIND_WRITE_OPTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-files0-from',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-ok',
  '-okdir',
])

/**
 * 跑一次后台总结 Agent 循环。
 *
 * 语义与 ZCode `runMemoryAgentLoop` 一致：
 *   - 最多 `maxTurns` 轮；
 *   - 每轮在**副本**上做 provider 请求（避免投影污染原始消息）；
 *   - 请求里带**主 Agent 的真实工具目录**，权限只在执行边界收窄；
 *   - 无 toolCall 即提前结束（`turns += 1; break`）；
 *   - 被拒的工具仍以 `isError: true` 的 tool 消息回灌，让模型自己纠正；
 *   - 每轮开头检查 `abortSignal`。
 *
 * @param {{
 *   abortSignal?: AbortSignal,
 *   executeTool: (toolCall: { id: string, input: unknown, name: string }, options: { abortSignal?: AbortSignal }) => Promise<{ content?: string, isError?: boolean } | string>,
 *   maxTurns: number,
 *   messages: readonly object[],
 *   model: { generateText(request: object): Promise<{ text?: string, reasoning?: unknown[], toolCalls?: Array<{ id: string, input: unknown, name: string }> }> },
 *   rootDir: string,
 *   tools: readonly object[],
 *   workingDirectory: string,
 *   workspaceRoot: string,
 * }} input 循环的全部依赖，均由调用方注入。
 * @returns {Promise<{ messages: object[], turns: number }>} 循环结束时的消息与轮次。
 */
export async function runMemoryAgentLoop(input) {
  const messages = input.messages.map(cloneModelMessage)
  let turns = 0

  for (; turns < input.maxTurns; turns += 1) {
    throwIfAborted(input.abortSignal)
    const request = {
      abortSignal: input.abortSignal,
      messages: messages.map(cloneModelMessage),
      // Memory agent 的 provider request 必须保留 Main 的真实工具目录；执行权限只在
      // tool-use 边界收窄。
      tools: input.tools,
    }
    const response = await input.model.generateText(request)
    throwIfAborted(input.abortSignal)

    const toolCalls = response.toolCalls ?? []
    messages.push(createAssistantMessage(response.text, response.reasoning, toolCalls))
    if (toolCalls.length === 0) {
      turns += 1
      break
    }

    const toolMessages = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const decision = evaluateMemoryAgentToolPolicy({
          rootDir: input.rootDir,
          toolCall,
          tools: input.tools,
          workingDirectory: input.workingDirectory,
          workspaceRoot: input.workspaceRoot,
        })
        if (!decision.allowed) {
          return {
            content: decision.reason,
            isError: true,
            role: 'tool',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          }
        }

        const result = await input.executeTool(
          { id: toolCall.id, input: toolCall.input, name: toolCall.name },
          { abortSignal: input.abortSignal },
        )
        return {
          content: typeof result === 'string' ? result : (result?.content ?? ''),
          isError: typeof result === 'string' ? false : result?.isError === true,
          role: 'tool',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }
      }),
    )
    messages.push(...toolMessages)
  }

  return { messages, turns }
}

/**
 * 判定后台 Agent 的一次工具调用是否放行。
 *
 * 出处：ZCode `memory-agent-loop.ts` `evaluateMemoryAgentToolPolicy`。判定顺序一致：
 * catalog miss → 网络/Agent 类 → Write/Edit → Bash → 只读白名单 → 默认拒绝。
 *
 * 命名差异（重要）：ZCode 的工具名是首字母大写的 `Read`/`Write`/`Edit`/`Bash`，
 * 而 **DSH 实际的工具名是全小写**（`dsh-tool-fs` 注册 `read`/`write`/`edit`，
 * `dsh-tool-fs-search` 注册 `glob`/`grep`，`dsh-tool-bash` 注册 `bash`）。因此这里
 * 一律用小写名；只认大写会让 DSH 里每一次记忆写入都被误拒。
 *
 * @param {{ rootDir: string, toolCall: { name: string, input?: unknown }, tools: readonly object[], workingDirectory: string, workspaceRoot: string }} input 判定输入。
 * @returns {{ allowed: true } | { allowed: false, reason: string }} 判定结果。
 */
export function evaluateMemoryAgentToolPolicy(input) {
  const contract = input.tools.find((tool) => tool?.name === input.toolCall.name)
  // catalog miss 被合并进 Memory 权限拒绝会让未注册工具没有先走 No such tool 错误处理。
  // 此分支只闭合原 call id，不进入工具执行面。
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name)

  if (
    input.toolCall.name === 'Agent' ||
    input.toolCall.name.startsWith('mcp__') ||
    contract.sideEffectScope === 'network'
  ) {
    return denyMemoryAgentTool(input.rootDir)
  }

  // 写入工具：ZCode 的 `Write`/`Edit`，以及 DSH 实际注册的 `write`/`edit`。
  if (MEMORY_AGENT_WRITE_TOOLS.has(input.toolCall.name)) {
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir)
  }

  // shell：ZCode 的 `Bash`，以及 DSH 实际注册的 `bash`。
  if (MEMORY_AGENT_SHELL_TOOLS.has(input.toolCall.name)) {
    const command = stringProperty(input.toolCall.input, 'command')
    if (command && isAllowedMemoryAgentBash(command, input)) {
      return { allowed: true }
    }
    return denyMemoryAgentBash(input.rootDir)
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    return { allowed: true }
  }

  return denyMemoryAgentTool(input.rootDir)
}

/**
 * 判断 Write/Edit 的目标是否是记忆目录内的 `.md`。
 *
 * 出处：ZCode `memory-agent-loop.ts` `isContainedMarkdownMutation`。
 *
 * @param {{ rootDir: string, toolCall: { input?: unknown }, workingDirectory: string, workspaceRoot: string }} input 判定输入。
 * @returns {boolean} 是否放行。
 */
export function isContainedMarkdownMutation(input) {
  const filePath = stringProperty(input.toolCall.input, 'file_path')
  if (!filePath?.endsWith('.md')) return false
  return resolveContainedMemoryFilePath({
    filePath,
    rootDir: input.rootDir,
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  }) !== undefined
}

/**
 * 保守的 Bash 放行判定。
 *
 * 放行两类命令（与 ZCode 的两个分支一一对应）：
 *   1. **只读命令**：命令名在 `READ_ONLY_BASH_COMMANDS` 内，且不含重定向、命令替换、
 *      管道、`;`/`&&`/`||` 串联与 `$()` —— 避免「看似只读、实际写入」的构造。
 *   2. **受限 `rm`**：单条命令、无重定向/变量赋值、非递归、无通配符、所有路径都是
 *      记忆目录内的绝对 `.md` 路径。
 *
 * 与 ZCode 的差异：ZCode 有完整的 shell 解析器（`analyzeBashCommand`）；这里用字符
 * 级保守检查代替。方向是「宁可多拒」，不放行任何解析不确定的输入。
 *
 * @param {string} command 命令文本。
 * @param {{ rootDir: string, workingDirectory: string, workspaceRoot: string }} input 判定输入。
 * @returns {boolean} 是否放行。
 */
function isAllowedMemoryAgentBash(command, input) {
  return isReadOnlyBashCommand(command) || isContainedMarkdownBashRemoval(command, input)
}

/**
 * 判断是否是安全的只读命令。
 *
 * 出处：ZCode `bash-readonly-policy-argv-direct.ts` `isSafeFindArgv` 与
 * `bash-readonly-policy-argv.ts` `hasKnownBashWriteOption`。ZCode 对只读命令**只**
 * 拒绝「写入选项」（find 的 `-delete`/`-exec`/`-fls`… 、sed 的 in-place、tree 的
 * `-o`），**不**因为参数里出现通配符而拒绝 —— 所以 `find . -name "*.md"` 在 ZCode
 * 里是放行的只读命令，这里也必须放行。
 *
 * 与 ZCode 的差异：ZCode 有完整 shell 解析器（`analyzeBashCommand`）。这里用字符级
 * 保守检查代替，只拒绝确定含写入/串联/替换语义的构造，方向是「宁可多拒」，但**不**
 * 拒 ZCode 明确放行的形态。
 *
 * @param {string} command 命令文本。
 * @returns {boolean} 是否放行。
 */
function isReadOnlyBashCommand(command) {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  // 重定向、命令替换、管道、串联：ZCode 的 areRedirectsAllowed 会拒，这里同样拒。
  if (/[><`|;&]|\$\(/u.test(trimmed)) return false

  const argv = trimmed.split(/\s+/u)
  const first = argv[0]
  if (!READ_ONLY_BASH_COMMANDS.has(first)) return false

  for (const argument of argv.slice(1)) {
    // find 的写入选项一律拒（出处：ZCode `FIND_WRITE_OPTIONS`）。
    if (FIND_WRITE_OPTIONS.has(argument)) return false
  }
  return true
}

/**
 * 判断是否是「受限的、删除记忆目录内 .md」的 rm。
 *
 * 出处：ZCode `memory-agent-loop.ts` `isContainedMarkdownBashRemoval`。
 *
 * @param {string} command 命令文本。
 * @param {{ rootDir: string, workingDirectory: string, workspaceRoot: string }} input 判定输入。
 * @returns {boolean} 是否放行。
 */
export function isContainedMarkdownBashRemoval(command, input) {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  // 单条命令、无重定向、无变量赋值、无串联。
  if (/[><`|;&]|\$\(/u.test(trimmed)) return false
  if (trimmed.includes('=')) return false

  const argv = trimmed.split(/\s+/u)
  if (argv[0] !== 'rm') return false

  let afterOptions = false
  let pathCount = 0
  for (const argument of argv.slice(1)) {
    if (!afterOptions) {
      if (argument === '--') {
        afterOptions = true
        continue
      }
      if (argument.startsWith('-')) {
        if (argument === '--recursive' || /^-[a-zA-Z]*[rR]/u.test(argument)) return false
        continue
      }
    }
    if (/[*?[]/u.test(argument)) return false
    if (!isAbsolute(argument) || !argument.endsWith('.md')) return false
    if (
      resolveContainedMemoryFilePath({
        filePath: argument,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) === undefined
    ) {
      return false
    }
    pathCount += 1
  }
  return pathCount > 0
}

/**
 * 把路径解析到记忆目录之内，越界或非法时返回 undefined。
 *
 * 出处：ZCode `memory-file-path.ts` `resolveContainedMemoryFilePath`。相对路径先按
 * `workingDirectory` 解析；最终结果必须落在 `rootDir` 之内。
 *
 * @param {{ filePath: string, rootDir: string, workingDirectory: string, workspaceRoot?: string }} input 解析输入。
 * @returns {string | undefined} 归一化后的绝对路径，或 undefined。
 */
export function resolveContainedMemoryFilePath(input) {
  if (typeof input.filePath !== 'string' || input.filePath.length === 0) return undefined
  if (input.filePath.includes('\0')) return undefined

  const absolute = isAbsolute(input.filePath)
    ? resolvePath(input.filePath)
    : resolvePath(input.workingDirectory ?? input.rootDir, input.filePath)

  const root = resolvePath(input.rootDir)
  if (absolute === root) return undefined
  if (!absolute.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return undefined
  return absolute
}

/**
 * 构造 assistant 消息。
 *
 * 出处：ZCode `memory-agent-loop.ts` `createAssistantMessage`/`assistantContent`。
 *
 * @param {string} [text] 文本。
 * @param {unknown[]} [reasoning] 推理块。
 * @param {readonly object[]} toolCalls 工具调用。
 * @returns {object} assistant 消息。
 */
function createAssistantMessage(text, reasoning, toolCalls) {
  const content = reasoning?.length
    ? [
        ...reasoning.map((block) => ({ ...block })),
        ...(text ? [{ text, type: 'text' }] : []),
      ]
    : (text ?? '')
  return {
    content,
    role: 'assistant',
    toolCalls: toolCalls.map((call) => ({ ...call })),
  }
}

/**
 * 深拷贝一条模型消息（provider 请求必须在副本上做）。
 *
 * 出处：ZCode `memory-agent-loop.ts` `cloneModelMessage`。
 *
 * @param {object} message 消息。
 * @returns {object} 副本。
 */
function cloneModelMessage(message) {
  return {
    ...message,
    cacheControl: message?.cacheControl ? { ...message.cacheControl } : undefined,
    content: Array.isArray(message?.content)
      ? message.content.map((block) => ({ ...block }))
      : message?.content,
    toolCalls: message?.toolCalls?.map((call) => ({ ...call })),
  }
}

/**
 * 读一个字符串属性。
 *
 * @param {unknown} value 对象。
 * @param {string} property 属性名。
 * @returns {string | undefined} 属性值。
 */
function stringProperty(value, property) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const propertyValue = value[property]
  return typeof propertyValue === 'string' ? propertyValue : undefined
}

/**
 * 若已取消则抛出。
 *
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {void}
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Memory agent loop aborted')
    error.name = 'AbortError'
    throw error
  }
}

/**
 * Bash 拒绝文案。
 *
 * 出处：ZCode `memory-agent-loop.ts` `denyMemoryAgentBash`（逐字符对齐）。
 *
 * @param {string} rootDir 记忆根目录。
 * @returns {{ allowed: false, reason: string }} 拒绝结果。
 */
export function denyMemoryAgentBash(rootDir) {
  return {
    allowed: false,
    reason: `Only read-only shell commands and rm with all paths inside ${rootDir} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  }
}

/**
 * 一般工具拒绝文案。
 *
 * 出处：ZCode `memory-agent-loop.ts` `denyMemoryAgentTool`（逐字符对齐）。
 *
 * @param {string} rootDir 记忆根目录。
 * @returns {{ allowed: false, reason: string }} 拒绝结果。
 */
export function denyMemoryAgentTool(rootDir) {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${rootDir} are allowed`,
  }
}

/**
 * 未注册工具拒绝文案。
 *
 * 出处：ZCode `memory-agent-loop.ts` `denyUnavailableMemoryAgentTool`（逐字符对齐）。
 *
 * @param {string} toolName 工具名。
 * @returns {{ allowed: false, reason: string }} 拒绝结果。
 */
export function denyUnavailableMemoryAgentTool(toolName) {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  }
}