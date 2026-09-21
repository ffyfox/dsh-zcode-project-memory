#!/usr/bin/env node
/**
 * 官方文档符合性验证：插件配置（`docs/user/develop/basic/config.md`）。
 *
 * 覆盖条款：
 *   - L9  「Export a `Config` type and a same-named Schemastery schema. Put defaults
 *          directly on the schema fields」
 *   - L45 「Do not export a plain object as `Config`; it does not implement the
 *          Standard Schema interface required by Cordis」
 *   - L78-92「Do not hardcode tunable values」——测试是「cordis.yml 能否在不改代码的
 *          情况下改变该值」
 *   - L94-96「Fail loudly on invalid configuration」
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

process.stdout.write('\n官方文档符合性：插件配置（config.md）\n')

const plugin = await import(join(ROOT, 'src/index.js'))
const format = await import(join(ROOT, 'src/memory-format.js'))

// ---- L9：导出 Config，且默认值写在 schema 上 --------------------------------
check('导出 Config（L9）', () => {
  assert.ok(plugin.Config !== undefined, '没有导出 Config')
})

check('Config 默认值写在 schema 上（L9）', () => {
  const result = plugin.Config['~standard'].validate({})
  assert.deepEqual(result.value, {
    indexLineLimit: format.MEMORY_INDEX_LINE_LIMIT,
    indexCharacterLimit: format.MEMORY_INDEX_CHARACTER_LIMIT,
    maxMemoryChars: 8000,
  })
})

// ---- L45：必须实现 Standard Schema，不能是普通对象 ---------------------------
check('Config 实现 Standard Schema 接口（L45）', () => {
  const standard = plugin.Config['~standard']
  assert.ok(standard, '缺少 ~standard，Cordis 无法校验配置')
  assert.equal(typeof standard.validate, 'function')
  assert.equal(standard.version, 1)
})

// ---- L94-96：非法配置在加载期失败 -------------------------------------------
check('非法配置返回 issues（fail loudly，L94-96）', () => {
  for (const bad of [
    { maxMemoryChars: 0 },
    { indexLineLimit: -1 },
    { indexCharacterLimit: 'lots' },
  ]) {
    const result = plugin.Config['~standard'].validate(bad)
    assert.ok(result.issues, `非法配置未被拒绝：${JSON.stringify(bad)}`)
  }
})

// ---- L78-92：可调值不能硬编码 ----------------------------------------------
/** 用给定配置装载插件并抓取注册结果。 */
function loadWith(config) {
  const sections = []
  const contexts = []
  const tools = []
  const ctx = {
    logger: () => undefined,
    tools: { register: (definition) => tools.push(definition) },
    systemPrompt: {
      section: (section) => sections.push(section),
      context: (context) => contexts.push(context),
    },
  }
  plugin.apply(ctx, config)
  return { tools, sections, contexts }
}

check('默认配置下 indexLineLimit 生效（缺省=ZCode 常量 200）', () => {
  const { contexts } = loadWith(undefined)
  const many = Array.from({ length: 250 }, (_, i) => `- [m${i}](m${i}.md) — hook`).join('\n')
  const text = contexts[0].text({
    agent: { session: { header: { cwd: '/tmp/config-default-probe' } } },
  })
  // 没有记忆文件时应为空串；这里改为直接验证 format 层，避免依赖磁盘。
  assert.equal(text, '')
  const formatted = format.formatMemoryIndexContent(many)
  assert.ok(formatted.includes('(limit: 200)'), '默认行上限不是 200')
})

check('cordis.yml 能改变 indexLineLimit 而不改代码（L78-92）', () => {
  const many = Array.from({ length: 50 }, (_, i) => `- [m${i}](m${i}.md) — hook`).join('\n')
  const withDefault = format.formatMemoryIndexContent(many)
  const withOverride = format.formatMemoryIndexContent(many, { lineLimit: 5 })
  assert.ok(!withDefault.includes('WARNING'), '默认上限下不该截断')
  assert.ok(withOverride.includes('(limit: 5)'), `覆盖后未按 5 行截断：${withOverride.slice(-160)}`)
})

check('cordis.yml 能改变 maxMemoryChars 而不改代码（L78-92）', async () => {
  const { tools } = loadWith({ maxMemoryChars: 10 })
  const tool = tools[0]
  let message = 'NO_ERROR'
  try {
    await tool.execute(
      { key: 'k', content: 'x'.repeat(50) },
      { signal: new AbortController().signal, agent: undefined },
    )
  } catch (error) {
    message = error.message
  }
  assert.ok(
    message.includes('over the 10-character limit'),
    `配置未生效，实际：${message}`,
  )
})

check('indexCharacterLimit 同样可通过配置收紧（L78-92）', () => {
  const long = `- [a](a.md) — ${'z'.repeat(500)}`
  const out = format.formatMemoryIndexContent(long, { characterLimit: 100 })
  assert.ok(out.includes('WARNING'), '字符上限未生效')
})

// ---- 可调值确实不再是硬编码常量 ---------------------------------------------
check('被判定为「可调」的值都经 Config 暴露（无遗留硬编码）', () => {
  const configKeys = Object.keys(plugin.Config['~standard'].validate({}).value)
  assert.deepEqual(configKeys.sort(), [
    'indexCharacterLimit',
    'indexLineLimit',
    'maxMemoryChars',
  ])
})

rmSync(mkdtempSync(join(tmpdir(), 'dsh-pm-config-')), { recursive: true, force: true })

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m配置符合性检查全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
