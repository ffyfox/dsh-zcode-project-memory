/**
 * 自动抽取子系统 —— ZCode `memory/extraction.ts` 的完整复刻。
 *
 * 这一层是**决策层**：它决定「这次 Turn 结束后要不要跑一次后台记忆抽取」，以及
 * 「给后台 Agent 的增量范围是哪些消息」。它自己**不**调用模型、**不**写文件 ——
 * 真正的执行由调用方通过 `execute` 回调注入（在 ZCode 里是
 * `runtime/helpers/project-memory-extraction.ts` 的 `executeProjectMemoryExtraction`，
 * 它再去调后台总结子系统）。
 *
 * 与 ZCode 的对应关系（出处：`apps/zcode-cli/packages/core/src/memory/extraction.ts`）：
 *
 * | 行为 | ZCode 出处 |
 * |---|---|
 * | `buildMemoryExtractionPrompt({manifest, messageCount})` | 同名函数 |
 * | `createMemoryExtractionScheduler(execute)` | 同名函数 |
 * | `MemoryExtractionScheduler` 五个方法 | 同名 interface |
 * | `MINIMUM_USER_WORDS = 3` | 同名常量 |
 * | 游标 `boundaryMessageId` 只截增量 | `countMessagesAfterCursor` |
 * | 跳过规则 `direct-memory-write` | `containsDirectMemoryWrite` |
 * | 跳过规则 `no-user-prose` | `containsEligibleUserProse` |
 * | snapshot coalescing（只保留最新 pending） | `schedule()` 的 `latestPending` |
 * | `shutdown()` 中止但不阻塞进程退出 | `shutdown()` + `shutdownController.abort()` |
 * | 失败不推进游标 | `processSnapshot` 的 catch |
 *
 * 刻意的差异（DSH 侧没有 ZCode 的会话类型）：ZCode 的 `MessageWithParts` 来自
 * `@zcode/contracts`，本插件按 DSH 的实际数据形状做**结构性**判定 —— 只读取
 * `info.role`/`info.id` 与 `parts[].type`/`parts[].text` 等字段，缺字段时按
 * 「不满足条件」处理（保守方向：宁可不抽取，也不滥发）。
 *
 * 该子系统可单独启用、单独调用；它对后台总结子系统的依赖是**参数注入**而非 import。
 *
 * @module dsh-zcode-project-memory/subsystems/extraction
 */

/**
 * 判定「用户说了实质内容」的最小词数。
 *
 * 出处：ZCode `extraction.ts` `const MINIMUM_USER_WORDS = 3`。
 */
export const MINIMUM_USER_WORDS = 3

/**
 * 构建交给后台抽取 Agent 的 Prompt。
 *
 * 出处：ZCode `extraction.ts` `buildMemoryExtractionPrompt`。文本逐段对齐，包含：
 *   - 只分析最近 N 条消息；
 *   - 工具白名单说明（只读 + 仅限记忆目录内的写/删）；
 *   - 轮次预算下的并行读写策略；
 *   - 不得再去调查验证；
 *   - 无内容时只输出 `Nothing to save.`；
 *   - 用户明确要求记住/忘记时的处置；
 *   - 已有记忆清单（非空时附上，并提示「先查清单，改既有文件而不是新建重复文件」）。
 *
 * @param {{ manifest: ReadonlyArray<{ description?: string, filename: string, mtimeMs: number, type?: string }>, messageCount: number, formatManifest: (manifest: readonly object[]) => string }} input
 *   `manifest` 是已有记忆清单（由 manifest 子系统产出）；`formatManifest` 是它的渲染
 *   函数（注入而非 import，保持子系统之间不隐式耦合）。
 * @returns {string} 抽取 Prompt。
 */
export function buildMemoryExtractionPrompt(input) {
  const manifest = input.manifest ?? []
  const existingMemories =
    manifest.length > 0
      ? `\n\n## Existing memory files\n\n${input.formatManifest(manifest)}\n\nCheck this list before writing \u2014 update an existing file rather than creating a duplicate.`
      : ''

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${input.messageCount} messages above and use them to update your persistent memory systems.`,
    '',
    'Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only, and Bash rm with paths inside the memory directory only. All other tools \u2014 MCP, Agent, write-capable Bash, etc \u2014 will be denied.',
    '',
    'You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 \u2014 issue all Read calls in parallel for every file you might update; turn 2 \u2014 issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.',
    '',
    `You MUST only use content from the last ~${input.messageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further \u2014 no grepping source files, no reading code to confirm a pattern exists, no git commands.${existingMemories}`,
    '',
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    'Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt \u2014 it is already in your context above.',
  ].join('\n')
}

/**
 * 抽取决策状态。
 *
 * @typedef {'success' | 'no-op' | 'error' | 'aborted'} MemoryExtractionExecutionStatus
 */

/**
 * 评估一次快照该不该抽取。
 *
 * 出处：ZCode `extraction.ts` `evaluateMemoryExtraction`。判定顺序与 ZCode 一致：
 * 先看是否刚发生过直接记忆写入，再看有没有合格的用户自然语言。
 *
 * @param {{ boundaryMessageId?: string, durableMessages: readonly object[] }} snapshot 会话快照。
 * @param {string} [cursor] 上次抽取到的消息 id。
 * @returns {{ decision: 'run', messageCount: number } | { decision: 'skip', messageCount: number, reason: 'direct-memory-write' | 'no-user-prose' }} 决策。
 */
export function evaluateMemoryExtraction(snapshot, cursor) {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor)

  if (containsDirectMemoryWrite(snapshot.durableMessages, cursor)) {
    return { decision: 'skip', messageCount, reason: 'direct-memory-write' }
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    return { decision: 'skip', messageCount, reason: 'no-user-prose' }
  }

  return { decision: 'run', messageCount }
}

/**
 * 创建抽取调度器。
 *
 * 出处：ZCode `extraction.ts` `createMemoryExtractionScheduler`。语义要点：
 *   - `schedule()` 永不阻塞调用方；已有运行中的抽取时，新快照**覆盖**待处理位
 *     （coalescing），不排队堆积；
 *   - 只有 `success`/`no-op` 才推进游标，`error` 不推进（下次重跑同一段）；
 *   - `skip` 也推进游标（这段已经判定过，不必重看）；
 *   - `shutdown()` 后不再接受新快照，并中止在途执行。
 *
 * @param {(input: { abortSignal: AbortSignal, messageCount: number, snapshot: object }) => Promise<MemoryExtractionExecutionStatus>} execute
 *   执行回调，由调用方注入（通常接到后台总结子系统）。
 * @returns {{ drain(): Promise<void>, getCursor(): string | undefined, hasPendingWork(): boolean, schedule(snapshot: object | Promise<object>): void, shutdown(): void }} 调度器。
 */
export function createMemoryExtractionScheduler(execute) {
  /** @type {string | undefined} */
  let cursor
  /** @type {Promise<{status: 'acquired', snapshot: object} | {status: 'error'}> | undefined} */
  let latestPending
  /** @type {Promise<void> | undefined} */
  let running
  let shuttingDown = false
  const shutdownController = new AbortController()

  const processSnapshot = async (snapshot) => {
    const decision = evaluateMemoryExtraction(snapshot, cursor)
    const snapshotEnd = snapshot.boundaryMessageId

    if (decision.decision === 'skip') {
      if (snapshotEnd) cursor = snapshotEnd
      return
    }

    let status
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot,
      })
    } catch {
      return
    }

    if (!shuttingDown && (status === 'success' || status === 'no-op') && snapshotEnd) {
      cursor = snapshotEnd
    }
  }

  const run = async (first) => {
    try {
      let current = first
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        )
        if (acquisition.status === 'shutdown' || shuttingDown) break
        if (acquisition.status === 'acquired') {
          try {
            await processSnapshot(acquisition.snapshot)
          } catch {
            // 本次 error 不推进 cursor；latest pending 仍按既有 coalescing 语义继续。
          }
        }
        current = shuttingDown ? undefined : latestPending
        latestPending = undefined
      }
    } finally {
      if (shuttingDown) latestPending = undefined
      running = undefined
    }
  }

  return {
    async drain() {
      while (running) {
        await running
      }
    },
    getCursor() {
      return cursor
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined
    },
    schedule(snapshot) {
      if (shuttingDown) return
      const acquisition = acquireSnapshot(snapshot)
      if (running) {
        latestPending = acquisition
        return
      }

      running = run(acquisition)
    },
    shutdown() {
      if (shuttingDown) return
      // ZCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方放弃等待，
      // running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true
      latestPending = undefined
      shutdownController.abort()
    },
  }
}

/**
 * 把「快照或快照 Promise」收敛成一个不会 reject 的 acquisition。
 *
 * @param {object | Promise<object>} snapshot 快照。
 * @returns {Promise<{status: 'acquired', snapshot: object} | {status: 'error'}>} acquisition。
 */
function acquireSnapshot(snapshot) {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: 'acquired', snapshot: value }),
    () => ({ status: 'error' }),
  )
}

/**
 * 等待 acquisition 完成，或在 shutdown 时立刻返回。
 *
 * 出处：ZCode `extraction.ts` `waitForSnapshotAcquisitionOrShutdown`。
 *
 * @param {Promise<object>} acquisition 待等的 acquisition。
 * @param {AbortSignal} signal 关闭信号。
 * @returns {Promise<object>} acquisition 或 shutdown 状态。
 */
function waitForSnapshotAcquisitionOrShutdown(acquisition, signal) {
  if (signal.aborted) return Promise.resolve({ status: 'shutdown' })

  return new Promise((resolve) => {
    const onAbort = () => {
      cleanup()
      resolve({ status: 'shutdown' })
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void acquisition.then((result) => {
      cleanup()
      resolve(result)
    })
  })
}

/**
 * 数出游标之后有多少条消息。
 *
 * 出处：ZCode `extraction.ts` `countMessagesAfterCursor`。游标找不到时按「全部都是
 * 新的」处理（`messages.length`）。
 *
 * @param {readonly object[]} messages 消息列表。
 * @param {string} [cursor] 游标消息 id。
 * @returns {number} 游标之后的消息数。
 */
export function countMessagesAfterCursor(messages, cursor) {
  if (!cursor) return messages.length
  const cursorIndex = messages.findIndex((message) => messageOf(message)?.id === cursor)
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1
}

/**
 * 取出游标之后的消息切片；游标**找不到**时返回 undefined。
 *
 * 出处：ZCode `extraction.ts` `messagesAfterFoundCursor`。这个 undefined 与
 * `countMessagesAfterCursor` 的「按全部处理」是有意的语义差异，两条路径的保守方向
 * 不同：计数宁多勿少，而「是否发生直接写入」在游标失配时宁可不判定。
 *
 * @param {readonly object[]} messages 消息列表。
 * @param {string} [cursor] 游标消息 id。
 * @returns {readonly object[] | undefined} 切片。
 */
function messagesAfterFoundCursor(messages, cursor) {
  if (!cursor) return messages
  const cursorIndex = messages.findIndex((message) => messageOf(message)?.id === cursor)
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1)
}

/**
 * 判断游标之后是否出现过「直接写记忆」。
 *
 * 出处：ZCode `extraction.ts` `containsDirectMemoryWrite`。ZCode 检查 assistant
 * 消息里 `Write`/`Edit` 的 `file_path` 是否落在记忆目录内；DSH 侧对应的直接写入是
 * `save_project_memory` 工具调用，因此这里检查该工具名。
 *
 * 不确定点：DSH 的记忆写入是**工具**（`save_project_memory`）而不是 ZCode 的
 * `Write`/`Edit` 文件路径，所以判定对象从「路径包含性」换成「工具名」。这是本插件
 * 与 ZCode 的既有差异（README「与 ZCode 的已知差异」）在抽取层的必然延伸。
 *
 * @param {readonly object[]} messages 消息列表。
 * @param {string} [cursor] 游标消息 id。
 * @returns {boolean} 是否应因直接写入而跳过。
 */
export function containsDirectMemoryWrite(messages, cursor) {
  const scoped = messagesAfterFoundCursor(messages, cursor)
  if (!scoped) return false

  for (const message of scoped) {
    if (messageOf(message)?.role !== 'assistant') continue
    for (const part of partsOf(message)) {
      if (part?.type !== 'tool') continue
      if (part.tool !== 'save_project_memory' && part.name !== 'save_project_memory') continue
      return true
    }
  }

  return false
}

/**
 * 判断游标之后是否存在合格的用户自然语言。
 *
 * 出处：ZCode `extraction.ts` `containsEligibleUserProse`。要求：非 meta 用户消息、
 * 非 synthetic、非 model-only，且某个 text part 词数 >= `MINIMUM_USER_WORDS`。
 *
 * 注意游标失配时这里退回**全量**消息（`?? messages`），与 ZCode 一致。
 *
 * @param {readonly object[]} messages 消息列表。
 * @param {string} [cursor] 游标消息 id。
 * @returns {boolean} 是否有实质用户输入。
 */
export function containsEligibleUserProse(messages, cursor) {
  const scoped = messagesAfterFoundCursor(messages, cursor) ?? messages
  for (const message of scoped) {
    if (!isNonMetaUserMessage(message)) continue
    for (const part of partsOf(message)) {
      if (
        part?.type === 'text' &&
        part.ignored !== true &&
        part.synthetic !== true &&
        countWords(part.text) >= MINIMUM_USER_WORDS
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * 判断是否是「真实用户」消息。
 *
 * 出处：ZCode `extraction.ts` `isNonMetaUserMessage`。
 *
 * @param {object} message 消息。
 * @returns {boolean} 是否计入用户自然语言。
 */
function isNonMetaUserMessage(message) {
  const info = messageOf(message)
  return (
    info?.role === 'user' && info.synthetic !== true && info.visibility !== 'model-only'
  )
}

/**
 * 取消息的元信息对象，兼容 `{info}` 与扁平两种形状。
 *
 * DSH 的消息形状与 ZCode 的 `MessageWithParts` 不完全一致，这里做结构性兼容；
 * 取不到时返回 undefined，让调用方按「不满足」处理。
 *
 * @param {object} message 消息。
 * @returns {object | undefined} 元信息。
 */
function messageOf(message) {
  if (!message || typeof message !== 'object') return undefined
  if (message.info && typeof message.info === 'object') return message.info
  return message
}

/**
 * 取消息的 parts 数组，取不到时返回空数组。
 *
 * @param {object} message 消息。
 * @returns {readonly object[]} parts。
 */
function partsOf(message) {
  const parts = message?.parts
  return Array.isArray(parts) ? parts : []
}

/**
 * 按空白切词计数。
 *
 * 出处：ZCode `extraction.ts` `countWords`。
 *
 * @param {unknown} text 文本。
 * @returns {number} 词数。
 */
function countWords(text) {
  if (typeof text !== 'string') return 0
  return text.split(/\s+/u).filter(Boolean).length
}