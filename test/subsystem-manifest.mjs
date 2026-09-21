#!/usr/bin/env node
/**
 * manifest 扫描子系统的最小可执行用例（验收标准 2 之一）。
 *
 * 独立于另外三个子系统：本文件只 import `src/subsystems/manifest.js`。
 * 产出物是**结构化文件清单**（manifest 条目数组），并在 stdout 打印 JSON，
 * 供上层解析。
 *
 * 同时验证与 ZCode `memory/recall/manifest.ts` 的逐项行为对齐。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MANIFEST_FILE_LIMIT,
  MANIFEST_PREVIEW_LINE_LIMIT,
  MEMORY_RECALL_TYPES,
  formatMemoryManifest,
  scanMemoryManifest,
} from '../src/subsystems/manifest.js'

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

const root = mkdtempSync(join(tmpdir(), 'dsh-pm-manifest-'))
const writeMemory = (name, { description, type, mtimeMs, body = 'body' } = {}) => {
  const frontmatter = [
    '---',
    'name: ignored-by-manifest',
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(type ? ['metadata:', `  type: ${type}`] : []),
    '---',
    '',
    body,
  ].join('\n')
  const filePath = join(root, name)
  writeFileSync(filePath, frontmatter, 'utf8')
  if (typeof mtimeMs === 'number') {
    const seconds = mtimeMs / 1000
    utimesSync(filePath, seconds, seconds)
  }
  return filePath
}

writeMemory('alpha.md', { description: 'first', type: 'user', mtimeMs: 1_000_000 })
writeMemory('beta.md', { description: 'second', type: 'project', mtimeMs: 3_000_000 })
writeMemory('gamma.md', { mtimeMs: 2_000_000 })
// 索引本身不能进 manifest。
writeFileSync(join(root, 'MEMORY.md'), '- [alpha](alpha.md)\n', 'utf8')
// 非 .md 不计入。
writeFileSync(join(root, 'notes.txt'), 'not a memory', 'utf8')
// 子目录递归计入。
mkdirSync(join(root, 'nested'))
writeFileSync(
  join(root, 'nested', 'deep.md'),
  ['---', 'description: "nested one"', 'metadata:', '  type: feedback', '---', ''].join('\n'),
  'utf8',
)
utimesSync(join(root, 'nested', 'deep.md'), 4, 4)
// 失效 symlink 安静跳过，不影响其他条目。
symlinkSync(join(root, 'missing.md'), join(root, 'broken.md'))

const manifest = await scanMemoryManifest({ rootDir: root })

// ---- 常量与 ZCode 对齐 ------------------------------------------------
check('MANIFEST_FILE_LIMIT 与 ZCode 一致（200）', () => {
  assert.equal(MANIFEST_FILE_LIMIT, 200)
})
check('MANIFEST_PREVIEW_LINE_LIMIT 与 ZCode 一致（30）', () => {
  assert.equal(MANIFEST_PREVIEW_LINE_LIMIT, 30)
})
check('MEMORY_RECALL_TYPES 与 ZCode types.ts 一致', () => {
  assert.deepEqual([...MEMORY_RECALL_TYPES], ['user', 'feedback', 'project', 'reference'])
})

// ---- 结构化产出 ------------------------------------------------------
check('产出是数组，且每个条目恰好是 ZCode 的字段集', () => {
  assert.ok(Array.isArray(manifest))
  assert.ok(manifest.length > 0)
  const allowed = new Set(['description', 'filePath', 'filename', 'mtimeMs', 'type'])
  for (const entry of manifest) {
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `unexpected key ${key}`)
    assert.equal(typeof entry.filePath, 'string')
    assert.equal(typeof entry.filename, 'string')
    assert.equal(typeof entry.mtimeMs, 'number')
    // ZCode 的条目没有 name 字段 —— name 不来自 frontmatter。
    assert.equal(entry.name, undefined)
  }
})
check('递归收集子目录', () => {
  assert.ok(manifest.some((entry) => entry.filename === 'nested/deep.md'))
})
check('跳过 MEMORY.md 索引本身', () => {
  assert.ok(!manifest.some((entry) => entry.filename === 'MEMORY.md'))
})
check('跳过非 .md 文件', () => {
  assert.ok(!manifest.some((entry) => entry.filename === 'notes.txt'))
})
check('失效 symlink 安静跳过', () => {
  assert.ok(!manifest.some((entry) => entry.filename === 'broken.md'))
})
check('按 mtimeMs 倒序', () => {
  const times = manifest.map((entry) => entry.mtimeMs)
  const sorted = [...times].sort((left, right) => right - left)
  assert.deepEqual(times, sorted)
})
check('解析出 description 与 metadata.type', () => {
  const beta = manifest.find((entry) => entry.filename === 'beta.md')
  assert.equal(beta.description, 'second')
  assert.equal(beta.type, 'project')
})
check('缺 frontmatter 字段时省略该键（不写 undefined）', () => {
  const gamma = manifest.find((entry) => entry.filename === 'gamma.md')
  assert.ok(!('description' in gamma))
  assert.ok(!('type' in gamma))
})
check('非法 type 被丢弃', () => {
  writeMemory('bogus.md', { type: 'not-a-real-type', mtimeMs: 5_000_000 })
  return scanMemoryManifest({ rootDir: root }).then((scanned) => {
    const bogus = scanned.find((entry) => entry.filename === 'bogus.md')
    assert.equal(bogus.type, undefined)
  })
})

// ---- formatMemoryManifest 逐字符对齐 ---------------------------------
check('formatMemoryManifest 输出格式与 ZCode 一致', () => {
  const rendered = formatMemoryManifest([
    { filename: 'a.md', mtimeMs: 0, type: 'user', description: 'hello' },
    { filename: 'b.md', mtimeMs: 0 },
  ])
  assert.equal(
    rendered,
    ['- [user] a.md (1970-01-01T00:00:00.000Z): hello', '- b.md (1970-01-01T00:00:00.000Z)'].join(
      '\n',
    ),
  )
})
check('空清单渲染为空串', () => {
  assert.equal(formatMemoryManifest([]), '')
})

// ---- 健壮性 ----------------------------------------------------------
check('目录不存在时返回空数组（不抛异常）', () => {
  return scanMemoryManifest({ rootDir: join(root, 'does-not-exist') }).then((scanned) => {
    assert.deepEqual(scanned, [])
  })
})
check('可注入自定义 fileSystem 端口（ZCode 的 FileSystemPort 形状）', () => {
  const calls = []
  const fakeFs = {
    async listDirectory({ path }) {
      calls.push(['listDirectory', path])
      return { entries: [{ kind: 'file', path: join(path, 'only.md') }] }
    },
    async stat({ path }) {
      calls.push(['stat', path])
      return { kind: 'file', mtimeMs: 42 }
    },
    async readTextFileRange({ path, limitLines }) {
      calls.push(['readTextFileRange', path, limitLines])
      return { content: '---\ndescription: "from port"\n---\n' }
    },
  }
  return scanMemoryManifest({ rootDir: '/virtual', fileSystem: fakeFs }).then((scanned) => {
    assert.equal(scanned.length, 1)
    assert.equal(scanned[0].description, 'from port')
    assert.equal(scanned[0].mtimeMs, 42)
    assert.ok(calls.some((call) => call[0] === 'readTextFileRange' && call[2] === 30))
  })
})

rmSync(root, { recursive: true, force: true })

// 结构化产出：打印可解析的 JSON。
process.stdout.write(
  `${JSON.stringify({ subsystem: 'manifest', count: manifest.length, entries: manifest })}\n`,
)

if (failures > 0) {
  process.stdout.write(`\nmanifest 子系统：${failures} 项失败\n`)
  process.exit(1)
}
process.stdout.write('\nmanifest 子系统：全部通过\n')
process.exit(0)