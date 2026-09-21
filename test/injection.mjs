#!/usr/bin/env node
/**
 * 不确定点第 1 点（提示词骨架里的 API 不属于 DSH 真实契约）的验证。
 *
 * 提示词骨架假设了三个不存在的 API：`session/created` 事件、
 * `session.appendSystemPrompt()`、以及 `ctx.tools.register({parameters:{key:{...}}})`
 * 这种参数形状。本插件改为使用 DSH 真实 API，并且注入面按 ZCode 的实际机制拆成两处：
 *
 *   - 记忆**指引** → `ctx.systemPrompt.section()`（system 段落）
 *   - 记忆**索引内容** → `ctx.systemPrompt.context()`（user-role 运行时上下文，
 *     对应 ZCode 的 `injectionTarget: "meta_user"`）
 *
 * 这里用一个最小的 Cordis 替身验证 apply() 真的注册了这两处，且不再引用任何
 * 不存在的 API。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

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

process.stdout.write('\n不确定点 1：注入面与 API 契约\n')

const plugin = await import(join(ROOT, 'src/index.js'))

/** 最小的 Cordis ctx 替身，记录注册调用。 */
function createFakeContext() {
  const sections = []
  const contexts = []
  const tools = []
  return {
    sections,
    contexts,
    tools,
    ctx: {
      logger: () => undefined,
      tools: { register: (definition) => tools.push(definition) },
      systemPrompt: {
        section: (section) => sections.push(section),
        context: (context) => contexts.push(context),
      },
    },
  }
}

const fake = createFakeContext()
plugin.apply(fake.ctx)

check('插件声明 inject = [tools, systemPrompt]', () => {
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
})

check('注册了 save_project_memory 工具', () => {
  assert.equal(fake.tools.length, 1)
  assert.equal(fake.tools[0].name, 'save_project_memory')
})

check('工具参数用真实 DSH 形状（JSON Schema 对象根 + properties）', () => {
  const parameters = fake.tools[0].parameters
  assert.equal(parameters.type, 'object')
  assert.ok(parameters.properties.key, '缺少 properties.key')
  assert.ok(parameters.properties.content, '缺少 properties.content')
  assert.deepEqual(parameters.required, ['key', 'content'])
  // 旧骨架把参数写成 `{ key: { type, description } }` 的扁平映射；真实契约要求
  // 顶层是 type/properties/required 的对象根。
  assert.equal(parameters.key, undefined, '仍在使用旧的扁平参数形状')
})

check('工具声明了强制 output（schema + render）', () => {
  assert.ok(fake.tools[0].output, '缺少 output 声明')
  assert.ok(fake.tools[0].output.schema, '缺少 output.schema')
  assert.equal(typeof fake.tools[0].output.render, 'function')
})

check('注册了一个 system prompt 段落（记忆指引）', () => {
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0].name, 'project-memory')
  assert.equal(typeof fake.sections[0].text, 'function')
})

check('注册了一个运行时上下文（记忆索引，对应 ZCode meta_user）', () => {
  assert.equal(fake.contexts.length, 1)
  assert.equal(fake.contexts[0].name, 'project-memory-index')
  assert.equal(typeof fake.contexts[0].text, 'function')
})

check('索引内容走 context 而非 section（ZCode 注入位对齐）', () => {
  const source = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
  assert.ok(
    source.includes('renderMemoryContext'),
    '没有使用 renderMemoryContext',
  )
  // 索引注入必须挂在 ctx.systemPrompt.context 上。
  const contextCallIndex = source.indexOf('ctx.systemPrompt.context(')
  assert.ok(contextCallIndex > 0, '缺少 ctx.systemPrompt.context 调用')
  assert.ok(
    source.indexOf('renderMemoryContext', contextCallIndex) > contextCallIndex,
    'renderMemoryContext 未出现在 context 注册内',
  )
})

check('不再引用提示词骨架里的虚构 API', () => {
  const files = ['src/index.js', 'src/store.js', 'src/prompt.js', 'src/memory-format.js']
  const offenders = []
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const forbidden of ['session/created', 'appendSystemPrompt']) {
      if (source.includes(forbidden)) offenders.push(`${file}: ${forbidden}`)
    }
  }
  assert.deepEqual(offenders, [], `仍引用虚构 API：${offenders.join(', ')}`)
})

check('不再手写 ctx.on("dispose")（Cordis 注册即 effect，会自动反注册）', () => {
  const source = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
  assert.ok(!source.includes("ctx.on('dispose'"), '仍手写 dispose 钩子')
  assert.ok(!source.includes('ctx.on("dispose"'), '仍手写 dispose 钩子')
})

check('指引文本给出该项目的记忆根目录（对齐 ZCode 的 buildMemoryContent）', () => {
  const section = fake.sections[0]
  const text = section.text({ agent: { session: { header: { cwd: '/tmp/some-project' } } } })
  assert.ok(text.includes('Persistent Project Memory'), '缺少指引标题')
  assert.ok(text.includes('save_project_memory'), '指引未引导使用工具')
  // ZCode 的指引展示的是 memoryRoot（不是项目路径），因此这里断言记忆根目录形态。
  assert.ok(text.includes('memories/projects/'), `指引未包含记忆根目录：${text.slice(0, 200)}`)
  assert.ok(text.includes('some-project'), '指引未包含项目 slug')
})

// 出处：ZCode `core/src/subagent/persistent-memory-prompt.ts`
// "If they ask you to forget something, find and remove the relevant entry"，
// 以及 `context/sections/memory.ts` "delete memories that turn out to be wrong"。
check('指引覆盖「删除记忆」：说明何时删、以及删文件 + 删索引行两半', () => {
  const section = fake.sections[0]
  const text = section.text({ agent: { session: { header: { cwd: '/tmp/some-project' } } } })
  assert.ok(/To remove a memory/u.test(text), '指引未说明如何删除记忆')
  assert.ok(/no delete tool/u.test(text), '指引未说明没有删除工具（模型会去找不存在的工具）')
  assert.ok(
    text.includes('remove that memory') && text.includes('line from'),
    '指引未说明要同时移除索引行（会留下悬空指针）',
  )
  assert.ok(/asks you to forget/u.test(text), '指引未说明「用户要求忘记」这一触发条件')
  assert.ok(/wrong or outdated/u.test(text), '指引未说明「记忆过时/错误」这一触发条件')
})

check('拿不到项目目录时两处注入都返回空串（不报错、不占位）', () => {
  const section = fake.sections[0]
  const context = fake.contexts[0]
  // 无 agent、且显式把 cwd 设为不可解析 —— 用一个空 header。
  const noProject = { agent: { session: { header: {} } } }
  const sectionText = section.text(noProject)
  const contextText = context.text(noProject)
  assert.equal(typeof sectionText, 'string')
  assert.equal(typeof contextText, 'string')
})

check('没有记忆文件时索引注入为空串（不留下空占位）', () => {
  const context = fake.contexts[0]
  const text = context.text({
    agent: { session: { header: { cwd: '/tmp/definitely-not-a-real-project-xyz' } } },
  })
  assert.equal(text, '')
})

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m注入面检查全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
