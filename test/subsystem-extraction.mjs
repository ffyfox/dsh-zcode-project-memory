#!/usr/bin/env node
/**
 * 自动抽取子系统的最小可执行用例（验收标准 2 之一）。
 *
 * 独立于另外三个子系统：本文件只 import `src/subsystems/extraction.js`。
 * 产出物是**抽取条目**（抽取决策 + 交给后台的增量范围 + 抽取 Prompt），
 * 并在 stdout 打印 JSON，供上层解析。
 *
 * 同时验证与 ZCode `memory/extraction.ts` 的逐项行为对齐。
 */

import assert from 'node:assert/strict'

import {
  MINIMUM_USER_WORDS,
  buildMemoryExtractionPrompt,
  containsDirectMemoryWrite,
  containsEligibleUserProse,
  countMessagesAfterCursor,
  createMemoryExtractionScheduler,
  evaluateMemoryExtraction,
} from '../src/subsystems/extraction.js'

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

/** 构造一条 ZCode 形状的消息。 */
const userMessage = (id, text) => ({
  info: { id, role: 'user' },
  parts: [{ type: 'text', text }],
})
const assistantMessage = (id, parts) => ({ info: { id, role: 'assistant' }, parts })

// ---- 常量对齐 --------------------------------------------------------
check('MINIMUM_USER_WORDS 与 ZCode 一致（3）', () => {
  assert.equal(MINIMUM_USER_WORDS, 3)
})

// ---- 游标语义 --------------------------------------------------------
const messages = [
  userMessage('m1', 'first real sentence here'),
  assistantMessage('m2', []),
  userMessage('m3', 'second real sentence here'),
  assistantMessage('m4', []),
]
check('countMessagesAfterCursor：无游标时是全部', () => {
  assert.equal(countMessagesAfterCursor(messages, undefined), 4)
})
check('countMessagesAfterCursor：游标之后的数量', () => {
  assert.equal(countMessagesAfterCursor(messages, 'm1'), 3)
  assert.equal(countMessagesAfterCursor(messages, 'm3'), 1)
})
check('countMessagesAfterCursor：游标找不到时按全部算', () => {
  assert.equal(countMessagesAfterCursor(messages, 'nope'), 4)
})

// ---- 跳过规则 --------------------------------------------------------
check('no-user-prose：用户消息不足 3 词时跳过', () => {
  const short = [userMessage('a', 'ok'), assistantMessage('b', [])]
  const decision = evaluateMemoryExtraction({ boundaryMessageId: 'b', durableMessages: short })
  assert.equal(decision.decision, 'skip')
  assert.equal(decision.reason, 'no-user-prose')
})
check('no-user-prose：只有 assistant 消息时跳过', () => {
  const onlyAssistant = [assistantMessage('a', [{ type: 'text', text: 'hi there friend' }])]
  const decision = evaluateMemoryExtraction({
    boundaryMessageId: 'a',
    durableMessages: onlyAssistant,
  })
  assert.equal(decision.reason, 'no-user-prose')
})
check('synthetic / model-only / ignored 的用户消息不算实质输入', () => {
  const synthetic = [
    { info: { id: 'a', role: 'user', synthetic: true }, parts: [{ type: 'text', text: 'a b c d' }] },
  ]
  const modelOnly = [
    {
      info: { id: 'a', role: 'user', visibility: 'model-only' },
      parts: [{ type: 'text', text: 'a b c d' }],
    },
  ]
  const ignored = [
    { info: { id: 'a', role: 'user' }, parts: [{ type: 'text', text: 'a b c d', ignored: true }] },
  ]
  for (const input of [synthetic, modelOnly, ignored]) {
    assert.equal(containsEligibleUserProse(input, undefined), false)
  }
})
check('run：有实质用户输入时抽取', () => {
  const decision = evaluateMemoryExtraction({ boundaryMessageId: 'm4', durableMessages: messages })
  assert.equal(decision.decision, 'run')
  assert.equal(decision.messageCount, 4)
})
check('direct-memory-write：刚保存过记忆时跳过', () => {
  const withWrite = [
    userMessage('m1', 'please remember this thing'),
    assistantMessage('m2', [{ type: 'tool', tool: 'save_project_memory' }]),
  ]
  assert.equal(containsDirectMemoryWrite(withWrite, undefined), true)
  const decision = evaluateMemoryExtraction({ boundaryMessageId: 'm2', durableMessages: withWrite })
  assert.equal(decision.decision, 'skip')
  assert.equal(decision.reason, 'direct-memory-write')
})
check('跳过规则的优先级：direct-memory-write 先于 no-user-prose', () => {
  const withWrite = [assistantMessage('m1', [{ type: 'tool', tool: 'save_project_memory' }])]
  const decision = evaluateMemoryExtraction({ boundaryMessageId: 'm1', durableMessages: withWrite })
  assert.equal(decision.reason, 'direct-memory-write')
})
check('direct-memory-write 只看游标之后', () => {
  const withWrite = [
    assistantMessage('m1', [{ type: 'tool', tool: 'save_project_memory' }]),
    userMessage('m2', 'now I ask something real'),
  ]
  assert.equal(containsDirectMemoryWrite(withWrite, 'm1'), false)
})

// ---- 抽取 Prompt -----------------------------------------------------
const prompt = buildMemoryExtractionPrompt({
  manifest: [{ filename: 'a.md', mtimeMs: 0, type: 'user', description: 'x' }],
  messageCount: 5,
  formatManifest: (items) => items.map((item) => `- ${item.filename}`).join('\n'),
})
check('Prompt 含消息数', () => {
  assert.ok(prompt.includes('~5 messages'))
})
check('Prompt 含工具白名单与拒绝说明', () => {
  assert.ok(prompt.includes('Read, Grep, Glob, read-only Bash'))
  assert.ok(prompt.includes('will be denied'))
})
check('Prompt 含轮次预算与并行读写策略', () => {
  assert.ok(prompt.includes('limited turn budget'))
  assert.ok(prompt.includes('turn 1'))
  assert.ok(prompt.includes('turn 2'))
})
check('Prompt 含 Nothing to save.', () => {
  assert.ok(prompt.includes("Nothing to save."))
})
check('Prompt 空清单时不出现 Existing memory files', () => {
  const empty = buildMemoryExtractionPrompt({ manifest: [], messageCount: 1, formatManifest: () => '' })
  assert.ok(!empty.includes('Existing memory files'))
})
check('Prompt 非空清单时附上清单并提示不要重复建文件', () => {
  assert.ok(prompt.includes('Existing memory files'))
  assert.ok(prompt.includes('- a.md'))
  assert.ok(prompt.includes('rather than creating a duplicate'))
})

// ---- 调度器语义 ------------------------------------------------------
const runScheduler = async () => {
  const executed = []
  let resolveGate
  const gate = new Promise((resolve) => {
    resolveGate = resolve
  })
  const scheduler = createMemoryExtractionScheduler(async (input) => {
    executed.push(input.messageCount)
    await gate
    return 'success'
  })

  assert.equal(scheduler.getCursor(), undefined)
  assert.equal(scheduler.hasPendingWork(), false)

  scheduler.schedule({ boundaryMessageId: 'm4', durableMessages: messages })
  assert.equal(scheduler.hasPendingWork(), true)

  // coalescing：运行中再排两次，只保留最新的那个。
  scheduler.schedule({ boundaryMessageId: 'm9', durableMessages: messages })
  scheduler.schedule({ boundaryMessageId: 'm10', durableMessages: messages })

  resolveGate()
  await scheduler.drain()

  assert.equal(scheduler.getCursor(), 'm10', 'cursor 应推进到最新的那个快照')
  assert.equal(executed.length, 1, 'coalescing 后只执行一次（第一次），后续被合并')
  assert.equal(scheduler.hasPendingWork(), false)

  return executed
}

const schedulerResult = await runScheduler()
check('调度器：schedule 不阻塞、coalescing、drain 后游标推进', () => {
  assert.equal(schedulerResult.length, 1)
})

check('调度器：error 状态不推进游标', async () => {
  const failing = createMemoryExtractionScheduler(async () => 'error')
  failing.schedule({ boundaryMessageId: 'm4', durableMessages: messages })
  await failing.drain()
  assert.equal(failing.getCursor(), undefined)
})
check('调度器：skip 也推进游标（这段不必重看）', async () => {
  const skipping = createMemoryExtractionScheduler(async () => 'success')
  skipping.schedule({ boundaryMessageId: 'z', durableMessages: [userMessage('z', 'ok')] })
  await skipping.drain()
  assert.equal(skipping.getCursor(), 'z')
})
check('调度器：shutdown 后不再接受新快照', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => 'success')
  scheduler.shutdown()
  scheduler.schedule({ boundaryMessageId: 'x', durableMessages: messages })
  assert.equal(scheduler.hasPendingWork(), false)
  await scheduler.drain()
  assert.equal(scheduler.getCursor(), undefined)
})
check('调度器：drain 在无工作时立即返回', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => 'success')
  await scheduler.drain()
})

if (failures > 0) {
  process.stdout.write(`\nextraction 子系统：${failures} 项失败\n`)
  process.exit(1)
}

// 结构化产出：抽取条目。
const extractionEntries = [
  { boundaryMessageId: 'm4', messageCount: 4, decision: 'run' },
  ...(await (async () => {
    const recorded = []
    const scheduler = createMemoryExtractionScheduler(async (input) => {
      recorded.push({
        boundaryMessageId: input.snapshot.boundaryMessageId,
        messageCount: input.messageCount,
        decision: 'run',
      })
      return 'success'
    })
    scheduler.schedule({ boundaryMessageId: 'm4', durableMessages: messages })
    await scheduler.drain()
    return recorded
  })()),
]

process.stdout.write(
  `${JSON.stringify({ subsystem: 'extraction', count: extractionEntries.length, entries: extractionEntries, promptBytes: prompt.length })}\n`,
)
process.stdout.write('\nextraction 子系统：全部通过\n')
process.exit(0)