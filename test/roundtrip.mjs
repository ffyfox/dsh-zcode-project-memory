#!/usr/bin/env node
/**
 * 验收标准 2 的验证：记忆的写入与读取闭环。
 *
 * 关键点是「跨进程」—— 写入发生在一个 node 进程里，读回发生在另一个**全新**的
 * node 进程里，这样才真正证明记忆落在磁盘上、而不是落在某个进程的内存里。
 * 读回的内容与写入内容做逐字符比对。
 *
 * 同时验证 ZCode 的记忆形态：MEMORY.md 是**索引**，每条记忆是**自己的文件**。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-pm-roundtrip-'))
const projectA = mkdtempSync(join(tmpdir(), 'pm-proj-a-'))
const projectB = mkdtempSync(join(tmpdir(), 'pm-proj-b-'))
const env = { ...process.env, DSH_HOME: join(sandbox, 'dsh-home') }

/** 在独立进程里执行脚本，返回 stdout。 */
const runInNewProcess = (script) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    cwd: ROOT,
  }).trim()

process.stdout.write('\n验收 2：写入 → 新进程读回（逐字符相等）\n')

const KEY = 'Auth token refresh gotcha'
const CONTENT = [
  'The refresh endpoint returns 401 (not 403) when the token is merely expired — 中文与 emoji 也要原样保留 🎯',
  '',
  '```js',
  'const x = `tick ${Date.now()}`',
  '```',
  '',
  '**Why:** retry logic keyed on 403 silently drops expired-token retries.',
].join('\n')

// ---- 进程 1：写入 ----------------------------------------------------------
const writeResult = JSON.parse(
  runInNewProcess(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const paths = resolveProjectMemoryPaths(${JSON.stringify(projectA)})
    const store = new ProjectMemoryStore(paths)
    const result = await store.save({
      key: ${JSON.stringify(KEY)},
      content: ${JSON.stringify(CONTENT)},
      type: 'project',
      originSessionId: 'session-abc',
    })
    process.stdout.write(JSON.stringify({ ...result, root: paths.root, indexFilePath: paths.indexFilePath }))
  `),
)
process.stdout.write(`  · 进程 1 写入：${writeResult.filePath}\n`)

// ---- 进程 2：读回 ----------------------------------------------------------
const readBack = JSON.parse(
  runInNewProcess(`
    import { readMemoryFileStable } from '${ROOT}/src/store.js'
    const snapshot = await readMemoryFileStable(${JSON.stringify(writeResult.filePath)})
    process.stdout.write(JSON.stringify(snapshot))
  `),
)

check('写入落在磁盘上（进程 1 退出后仍可读）', () => assert.equal(readBack.exists, true))
check('新进程读回的正文逐字符包含写入内容', () =>
  assert.ok(readBack.content.includes(CONTENT), '读回内容未逐字包含写入正文'),
)
check('多字节字符未被改写（中文/emoji 原样往返）', () =>
  assert.ok(readBack.content.includes('中文与 emoji 也要原样保留 🎯')),
)
check('正文里的反引号与代码块原样往返', () =>
  assert.ok(readBack.content.includes('const x = `tick ${Date.now()}`')),
)

// ---- ZCode 记忆形态 --------------------------------------------------------
check('记忆是独立文件（不是写进 MEMORY.md）', () => {
  assert.equal(writeResult.fileName, 'auth-token-refresh-gotcha.md')
  assert.ok(writeResult.filePath.endsWith('/auth-token-refresh-gotcha.md'))
})

check('记忆文件带 ZCode 形态的 frontmatter', () => {
  assert.match(readBack.content, /^---\n/u, '缺少 frontmatter 起始')
  assert.ok(readBack.content.includes('name: "auth-token-refresh-gotcha"'))
  assert.ok(readBack.content.includes('metadata:'))
  assert.ok(readBack.content.includes('  type: project'))
  assert.ok(readBack.content.includes('  node_type: memory'))
  assert.ok(readBack.content.includes('  originSessionId: "session-abc"'))
})

const indexContent = readFileSync(writeResult.indexFilePath, 'utf8')
check('MEMORY.md 是索引：一行一条 `- [Title](file.md) — hook`', () => {
  assert.ok(
    indexContent.includes(
      '- [Auth token refresh gotcha](auth-token-refresh-gotcha.md) — The refresh endpoint returns 401',
    ),
    `索引内容不符：${JSON.stringify(indexContent)}`,
  )
})
check('MEMORY.md 不含记忆正文（索引不放内容）', () => {
  assert.ok(!indexContent.includes('const x = `tick'), 'MEMORY.md 里出现了记忆正文')
})

// ---- 记忆根目录布局对齐 ZCode ----------------------------------------------
check('记忆根目录是 ZCode 布局 <DSH_HOME>/memories/projects/<slug>-<hash>/memory', () => {
  assert.match(writeResult.root, /\/memories\/projects\/pm-proj-a-[a-z0-9]+-[a-f0-9]{16}\/memory$/u)
})

// ---- 同一条记忆重复保存：替换而非重复 ---------------------------------------
runInNewProcess(`
  import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
  const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(projectA)}))
  await store.save({ key: ${JSON.stringify(KEY)}, content: 'UPDATED v2', type: 'project' })
  process.stdout.write('ok')
`)

const afterUpdate = JSON.parse(
  runInNewProcess(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore, readMemoryFileStable } from '${ROOT}/src/store.js'
    const paths = resolveProjectMemoryPaths(${JSON.stringify(projectA)})
    const store = new ProjectMemoryStore(paths)
    const index = await store.readIndex()
    const file = await readMemoryFileStable(${JSON.stringify(writeResult.filePath)})
    process.stdout.write(JSON.stringify({
      index: index.content,
      body: file.content,
      entryCount: index.content.trim().split('\\n').filter(Boolean).length,
    }))
  `),
)

check('重复保存同一条记忆：索引条目数不变（不重复）', () =>
  assert.equal(afterUpdate.entryCount, 1),
)
check('重复保存同一条记忆：正文被替换为新内容', () => {
  assert.ok(afterUpdate.body.includes('UPDATED v2'))
  assert.ok(!afterUpdate.body.includes('const x = `tick'), '旧正文仍在')
})

// ---- 隔离性 -----------------------------------------------------------------
runInNewProcess(`
  import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
  const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(projectB)}))
  await store.save({ key: 'B only', content: 'B_PROJECT_SECRET' })
  process.stdout.write('ok')
`)

const pathsA = JSON.parse(
  runInNewProcess(`
    import { resolveProjectMemoryPaths } from '${ROOT}/src/store.js'
    process.stdout.write(JSON.stringify(resolveProjectMemoryPaths(${JSON.stringify(projectA)})))
  `),
)
const pathsB = JSON.parse(
  runInNewProcess(`
    import { resolveProjectMemoryPaths } from '${ROOT}/src/store.js'
    process.stdout.write(JSON.stringify(resolveProjectMemoryPaths(${JSON.stringify(projectB)})))
  `),
)

check('不同项目解析到不同的记忆根目录', () => assert.notEqual(pathsA.root, pathsB.root))

const contentA = JSON.parse(
  runInNewProcess(`
    import { resolveProjectMemoryPaths, ProjectMemoryStore } from '${ROOT}/src/store.js'
    const store = new ProjectMemoryStore(resolveProjectMemoryPaths(${JSON.stringify(projectA)}))
    const index = await store.readIndex()
    const entries = await store.listEntries()
    process.stdout.write(JSON.stringify({ index: index.content, entries }))
  `),
)

check('项目 A 读不到项目 B 的记忆', () => {
  assert.ok(!contentA.index.includes('B_PROJECT_SECRET'), 'A 的索引里有 B 的秘密')
  assert.ok(!contentA.index.includes('B only'), 'A 的索引里有 B 的标题')
  assert.equal(contentA.entries.length, 1, `A 看到了 ${contentA.entries.length} 条记忆`)
})
check('项目 A 仍然读得到自己的记忆', () => assert.ok(contentA.index.includes('UPDATED v2')))

rmSync(sandbox, { recursive: true, force: true })
rmSync(projectA, { recursive: true, force: true })
rmSync(projectB, { recursive: true, force: true })

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m闭环验证全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
