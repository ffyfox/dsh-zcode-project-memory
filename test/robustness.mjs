#!/usr/bin/env node
/**
 * 不确定点第 5 点（并发写 / 写入读取健壮性）的验证：确认实现复刻了 ZCode 的实际机制，
 * 而不是自创一套。
 *
 * 被验证的 ZCode 机制与出处：
 *   - 拒绝写穿符号链接 → `apps/zcode-cli/packages/adapters/src/fs/index.ts`（`atomicWrite`）
 *   - 保留既有文件权限位 → 同上（`handle.chmod(existingMode)`）
 *   - 临时文件独占创建 + rename → 同上
 *   - 稳定读取拒绝符号链接 → `packages/services/src/memory/projectMemoryStableRead.ts`
 *   - 读取体积上限 → 同上（`PROJECT_MEMORY_PREVIEW_MAX_BYTES`）
 *   - 路径包含性检查 + 敏感段拒绝 → `core/src/memory/memory-file-path.ts`
 *   - 写入期 frontmatter 标注 → `core/src/memory/origin-session.ts`
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-pm-robust-'))
const project = mkdtempSync(join(tmpdir(), 'pm-robust-proj-'))
const env = { ...process.env, DSH_HOME: join(sandbox, 'dsh-home') }

const run = (script) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    cwd: ROOT,
  }).trim()

process.stdout.write('\n不确定点 5：写入/读取健壮性（对齐 ZCode）\n')

const paths = JSON.parse(
  run(`
    import { resolveProjectMemoryPaths } from '${ROOT}/src/store.js'
    process.stdout.write(JSON.stringify(resolveProjectMemoryPaths(${JSON.stringify(project)})))
  `),
)

// ---- 1. 拒绝写穿符号链接 ----------------------------------------------------
const victim = join(sandbox, 'victim.txt')
writeFileSync(victim, 'ORIGINAL')
const linkPath = join(paths.root, 'linked.md')
execFileSync('mkdir', ['-p', paths.root])
symlinkSync(victim, linkPath)

check('写入拒绝符号链接目标（不写穿到链接指向的文件）', () => {
  const out = run(`
    import { writeFileAtomic } from '${ROOT}/src/store.js'
    let code = 'NO_ERROR'
    try {
      await writeFileAtomic(${JSON.stringify(linkPath)}, 'HIJACKED')
    } catch (error) {
      code = error.code ?? error.name
    }
    process.stdout.write(String(code))
  `)
  assert.equal(out, 'SYMLINK_WRITE_REFUSED', `期望拒绝，实际：${out}`)
})

check('符号链接指向的原文件未被改写', () => {
  assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL')
})

// ---- 2. 保留既有权限位 ------------------------------------------------------
check('原子写保留既有文件权限位', () => {
  const target = join(paths.root, 'mode-test.md')
  writeFileSync(target, 'v1')
  chmodSync(target, 0o640)
  const before = statSync(target).mode & 0o777
  run(`
    import { writeFileAtomic } from '${ROOT}/src/store.js'
    await writeFileAtomic(${JSON.stringify(target)}, 'v2')
    process.stdout.write('ok')
  `)
  const after = statSync(target).mode & 0o777
  assert.equal(after, before, `权限位被改动：${before.toString(8)} → ${after.toString(8)}`)
})

// ---- 3. 原子替换：读者只看到完整内容 ----------------------------------------
check('原子替换后内容是完整的新内容（无残留临时文件）', () => {
  const target = join(paths.root, 'atomic-test.md')
  run(`
    import { writeFileAtomic } from '${ROOT}/src/store.js'
    await writeFileAtomic(${JSON.stringify(target)}, 'COMPLETE-NEW-CONTENT')
    process.stdout.write('ok')
  `)
  assert.equal(readFileSync(target, 'utf8'), 'COMPLETE-NEW-CONTENT')
  const leftovers = readdirSync(paths.root).filter((name) => name.includes('.tmp.'))
  assert.deepEqual(leftovers, [], `残留临时文件：${leftovers.join(', ')}`)
})

// ---- 4. 稳定读取拒绝符号链接 ------------------------------------------------
check('稳定读取拒绝符号链接（不跟随到目标）', () => {
  const out = run(`
    import { readMemoryFileStable } from '${ROOT}/src/store.js'
    const snapshot = await readMemoryFileStable(${JSON.stringify(linkPath)})
    process.stdout.write(JSON.stringify(snapshot))
  `)
  const snapshot = JSON.parse(out)
  assert.equal(snapshot.exists, false, '符号链接被当作正常文件读取了')
  assert.equal(snapshot.content, '')
})

// ---- 5. 路径包含性检查 ------------------------------------------------------
check('路径包含性检查拒绝逃出记忆根目录的路径', () => {
  const out = run(`
    import { assertContainedMemoryPath } from '${ROOT}/src/store.js'
    const root = ${JSON.stringify(paths.root)}
    let escaped = 'ALLOWED'
    try { assertContainedMemoryPath(root, root + '/../../outside.md') } catch { escaped = 'REJECTED' }
    let inside = 'REJECTED'
    try { assertContainedMemoryPath(root, root + '/inside.md'); inside = 'ALLOWED' } catch {}
    process.stdout.write(escaped + ':' + inside)
  `)
  assert.equal(out, 'REJECTED:ALLOWED', out)
})

check('敏感路径段被拒绝（node_modules / .git 等）', () => {
  const out = run(`
    import { assertSafeMemoryFileName } from '${ROOT}/src/store.js'
    const cases = ['node_modules.md', 'ok-name.md']
    const results = cases.map((name) => {
      try { assertSafeMemoryFileName(name); return 'ALLOWED' } catch { return 'REJECTED' }
    })
    // 另测路径穿越与非 .md 后缀。
    const bad = ['../escape.md', 'sub/dir.md', 'no-extension']
    for (const name of bad) {
      try { assertSafeMemoryFileName(name); results.push('ALLOWED') } catch { results.push('REJECTED') }
    }
    process.stdout.write(results.join(','))
  `)
  // node_modules.md 本身不是敏感「段」（段是 node_modules），因此允许；其余必须拒绝。
  assert.equal(out, 'ALLOWED,ALLOWED,REJECTED,REJECTED,REJECTED', out)
})

check('slug 净化阻止路径穿越（结果始终是单一安全路径段）', () => {
  const out = run(`
    import { sanitizeMemorySlug } from '${ROOT}/src/memory-format.js'
    process.stdout.write([
      sanitizeMemorySlug('../../etc/passwd'),
      sanitizeMemorySlug('Auth Token Refresh'),
      sanitizeMemorySlug(''),
      sanitizeMemorySlug('..'),
    ].join('|'))
  `)
  const [traversal, spaced, empty, dots] = out.split('|')
  // ZCode 的 sanitizeProjectSlug 允许 `.`（字符类是 [a-z0-9._-]），因此 `..` 会保留为
  // 普通字符；安全性来自「结果永远是单一路径段」，而不是「不含点」。
  assert.ok(!traversal.includes('/'), `slug 仍含路径分隔符：${traversal}`)
  assert.equal(spaced, 'auth-token-refresh')
  assert.equal(empty, 'memory')
  for (const slug of [traversal, spaced, empty, dots]) {
    assert.equal(basename(slug), slug, `slug 不是单一目录段：${slug}`)
    assert.notEqual(slug, '.')
    assert.notEqual(slug, '..')
  }
})

// ---- 6. 写入期 frontmatter 标注（origin-session） ---------------------------
check('新建记忆标注 node_type 与 originSessionId', () => {
  const out = run(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore, readMemoryFileStable } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(project)}))
    const result = await store.save({ key: 'Origin test', content: 'body', originSessionId: 'sess-42' })
    const snapshot = await readMemoryFileStable(result.filePath)
    process.stdout.write(snapshot.content)
  `)
  assert.ok(out.includes('  node_type: memory'), '缺少 node_type')
  assert.ok(out.includes('  originSessionId: "sess-42"'), '缺少 originSessionId')
})

// ---- 7. 读取体积上限 --------------------------------------------------------
check('超过读取上限的文件被当作不可读（不返回内容）', () => {
  const big = join(paths.root, 'huge.md')
  // 6 MiB > PROJECT_MEMORY_PREVIEW_MAX_BYTES (5 MiB)
  writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x61))
  const out = run(`
    import { readMemoryFileStable } from '${ROOT}/src/store.js'
    const snapshot = await readMemoryFileStable(${JSON.stringify(big)})
    process.stdout.write(JSON.stringify({ exists: snapshot.exists, length: snapshot.content.length }))
  `)
  const snapshot = JSON.parse(out)
  assert.equal(snapshot.exists, false, '超大文件被读取了')
  assert.equal(snapshot.length, 0)
})

// ---- 8. 并发写不丢内容 ------------------------------------------------------
check('并发写同一项目：索引不丢条目', () => {
  const out = run(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(project)}))
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.save({ key: 'Concurrent ' + i, content: 'body ' + i }),
      ),
    )
    const index = await store.readIndex()
    process.stdout.write(JSON.stringify({ lines: index.content.trim().split('\\n').filter(Boolean).length }))
  `)
  const result = JSON.parse(out)
  assert.ok(
    result.lines >= 5,
    `并发写入后索引只有 ${result.lines} 条（期望 ≥5）`,
  )
})

// ---- 9. 工具契约：honor exec.signal ----------------------------------------
// 出处：docs/cookbook/adding-a-tool.md（Rules of the execute() contract —
// "Honor `exec.signal`. Cancel in-flight work when it fires."）
check('预先取消的 exec.signal 使保存立刻失败且不落盘', () => {
  const out = run(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(project)}))
    const controller = new AbortController()
    controller.abort()
    let outcome = 'NO_ERROR'
    try {
      await store.save({ key: 'Aborted', content: 'body', signal: controller.signal })
    } catch (error) {
      outcome = error.name
    }
    const entries = await store.listEntries()
    process.stdout.write(JSON.stringify({
      outcome,
      wroteAbortedFile: entries.some((entry) => entry.fileName === 'aborted.md'),
    }))
  `)
  const result = JSON.parse(out)
  assert.equal(result.outcome, 'AbortError', `期望 AbortError，实际 ${result.outcome}`)
  assert.equal(result.wroteAbortedFile, false, '取消后仍然落盘了')
})

check('读取路径同样传播 exec.signal（不把取消降级成「没有记忆」）', () => {
  const out = run(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(project)}))
    const controller = new AbortController()
    controller.abort()
    let outcome = 'NO_ERROR'
    try { await store.readIndex(controller.signal) } catch (error) { outcome = error.name }
    process.stdout.write(outcome)
  `)
  assert.equal(out, 'AbortError', `期望 AbortError，实际 ${out}`)
})

check('未取消的 signal 不影响正常写入（observe 而非一律拒绝）', () => {
  const out = run(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(project)}))
    const result = await store.save({
      key: 'Live signal', content: 'body', signal: new AbortController().signal,
    })
    process.stdout.write(result.fileName)
  `)
  assert.equal(out, 'live-signal.md')
})

// ---- 10. 工具契约：raw JSON Schema 工具自己负责输入校验 ---------------------
// 出处：docs/cookbook/adding-a-tool.md（"Raw JSON-Schema tools registered directly
// own their input validation"）。parameters 声明了 additionalProperties: false，
// 行为必须与声明一致。
check('工具拒绝未声明的参数（与 additionalProperties: false 一致）', async () => {
  const plugin = await import(join(ROOT, 'src/index.js'))
  const tools = []
  plugin.apply({
    logger: () => undefined,
    tools: { register: (definition) => tools.push(definition) },
    systemPrompt: { section: () => undefined, context: () => undefined },
  })
  let message = 'NO_ERROR'
  try {
    await tools[0].execute(
      { key: 'k', content: 'v', bogus: 'x' },
      { signal: new AbortController().signal, agent: undefined },
    )
  } catch (error) {
    message = error.message
  }
  assert.ok(message.includes('unknown parameter'), `未拒绝未知参数：${message}`)
})

check('工具对空 key/content 自行校验（raw 注册不代做）', async () => {
  const plugin = await import(join(ROOT, 'src/index.js'))
  const tools = []
  plugin.apply({
    logger: () => undefined,
    tools: { register: (definition) => tools.push(definition) },
    systemPrompt: { section: () => undefined, context: () => undefined },
  })
  let message = 'NO_ERROR'
  try {
    await tools[0].execute(
      { key: '   ', content: 'v' },
      { signal: new AbortController().signal, agent: undefined },
    )
  } catch (error) {
    message = error.message
  }
  assert.ok(message.includes('non-empty'), `未拒绝空 key：${message}`)
})

// ---- 11. 非 ASCII key 不得互相覆盖（回归：曾导致记忆丢失） -------------------
// 背景：slug 净化沿用 ZCode 的字符类 `[a-z0-9._-]`，非 ASCII 字符被整体丢弃，
// 导致 `你的哨兵` / `发布前检查` / `部署规则` 全部塌缩成 `memory.md`，后写的覆盖先写的。
check('非 ASCII key 派生互不相同的文件名（不再塌缩）', () => {
  const out = run(`
    import { sanitizeMemorySlug } from '${ROOT}/src/memory-format.js'
    const keys = ['你的哨兵', '发布前检查', '部署规则', 'Auth 令牌']
    process.stdout.write(JSON.stringify(keys.map((k) => sanitizeMemorySlug(k))))
  `)
  const slugs = JSON.parse(out)
  assert.equal(new Set(slugs).size, slugs.length, `仍有塌缩：${slugs.join(', ')}`)
})

check('纯 ASCII key 的文件名保持不变（不破坏已有记忆）', () => {
  const out = run(`
    import { sanitizeMemorySlug } from '${ROOT}/src/memory-format.js'
    process.stdout.write([
      sanitizeMemorySlug('Auth token refresh gotcha'),
      sanitizeMemorySlug('Build memory limit'),
    ].join('|'))
  `)
  assert.equal(out, 'auth-token-refresh-gotcha|build-memory-limit')
})

check('中文 key 保存两条记忆后：两条都还在（端到端不丢数据）', () => {
  // 用独立项目目录，避免受本文件前面几项测试已写入的记忆影响。
  const isolatedProject = mkdtempSync(join(tmpdir(), 'pm-cjk-'))
  try {
    const out = run(`
      import { resolveProjectMemoryPaths, ProjectMemoryStore, readMemoryFileSync } from '${ROOT}/src/store.js'
      const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(isolatedProject)}))
      await store.save({ key: '部署规则', content: '第一条中文记忆' })
      await store.save({ key: '发布前检查', content: '第二条中文记忆' })
      const entries = await store.listEntries()
      const index = readMemoryFileSync(store.indexFilePath)
      process.stdout.write(JSON.stringify({
        fileCount: entries.length,
        indexLines: index.trim().split('\\n').filter(Boolean).length,
        hasFirst: index.includes('部署规则'),
        hasSecond: index.includes('发布前检查'),
      }))
    `)
    const result = JSON.parse(out)
    assert.equal(result.fileCount, 2, `期望 2 个记忆文件，实际 ${result.fileCount}`)
    assert.equal(result.indexLines, 2, `期望 2 条索引，实际 ${result.indexLines}`)
    assert.equal(result.hasFirst, true, '第一条中文记忆被覆盖了')
    assert.equal(result.hasSecond, true, '第二条中文记忆丢了')
  } finally {
    rmSync(isolatedProject, { recursive: true, force: true })
  }
})

rmSync(sandbox, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m健壮性检查全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
