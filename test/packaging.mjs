#!/usr/bin/env node
/**
 * 打包与运行时读取面的验证。
 *
 * 三个可机器判定的检查面：
 *   1. **打包清单**：`npm pack` 的真实产物只含预期内容（`files` 白名单 + npm 自身
 *      的忽略规则叠加后的结果，而不是只读 `package.json` 的声明）；
 *   2. **运行时读取路径**：源码里不存在读取仓库根目录下 `.md` 文件的痕迹 ——
 *      记忆只从 `resolveProjectMemoryPaths()` 派生的目录读取；
 *   3. **对外入口**：`exports` / `main` 与 cordis patch 指向的入口可解析，入口闭包
 *      不引用仓库内的开发期文件。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 发布产物中允许出现的顶层文件。
 *
 * 断言方式是「白名单之外一律不允许」，因此任何不该发布的文件（开发期草稿、临时
 * 笔记等）一进入产物就会失败 —— 不需要逐个点名不该存在的文件。
 */
const ALLOWED_TOP_LEVEL = new Set([
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'LICENSE-APACHE-2.0',
  'NOTICE.md',
  'NOTICE-ZCode.md',
  'cordis.patch.yml',
])

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

/** 递归列出仓库内的文件（跳过 node_modules / .git）。 */
const listFiles = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

process.stdout.write('\n打包与运行时读取面检查\n')

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ---- 1. 打包清单 -----------------------------------------------------------
check('files 白名单只列出允许发布的内容', () => {
  const files = manifest.files ?? []
  const allowedPrefixes = ['src', 'cordis.patch.yml', 'README', 'LICENSE', 'NOTICE']
  const offenders = files.filter(
    (entry) => !allowedPrefixes.some((prefix) => entry.startsWith(prefix)),
  )
  assert.deepEqual(offenders, [], `files 白名单里有未预期条目：${offenders.join(', ')}`)
})

check('npm pack 的真实产物符合预期', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // `npm pack --json` 的顶层是「包名 → 结果」的对象（不是数组），按包名取用。
  const parsed = JSON.parse(output)
  const result = parsed[manifest.name] ?? Object.values(parsed)[0]
  assert.ok(result, 'npm pack 没有返回结果')
  const files = (result.files ?? []).map((entry) => entry.path)
  // 同时确认产物本身非空 —— 否则「没有多余文件」可能只是因为什么都没打进去。
  assert.ok(files.length > 0, '打包产物为空，检查无意义')
  // 入口文件必须在产物里，否则「入口不含该引用」也无从谈起。
  assert.ok(files.includes(manifest.main), `打包产物缺少入口 ${manifest.main}`)
  // 三个子系统随包发布。
  for (const subsystem of ['manifest', 'extraction', 'summarization']) {
    assert.ok(
      files.includes(`src/subsystems/${subsystem}.js`),
      `打包产物缺少子系统 src/subsystems/${subsystem}.js`,
    )
  }
  // 白名单之外的文件一律不允许进入产物：任何开发期草稿、临时笔记都会在此暴露。
  const unexpected = files.filter(
    (path) => !path.startsWith('src/') && !ALLOWED_TOP_LEVEL.has(path),
  )
  assert.deepEqual(unexpected, [], `打包产物里出现了未预期文件：${unexpected.join(', ')}`)
})

// ---- 2. 运行时读取路径 -----------------------------------------------------
check('源码不读取仓库根目录下的任何 .md 文件（运行时读取面收敛）', () => {
  const offenders = []
  for (const file of listFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    // 只允许读取由 resolveProjectMemoryPaths 派生出的记忆文件；这里检查是否存在
    // 直接拼接仓库内 .md 路径的痕迹。
    if (/readFileSync\([^)]*\.md/u.test(text) || /readFile\([^)]*\.md/u.test(text)) {
      offenders.push(relative(ROOT, file))
    }
  }
  assert.deepEqual(offenders, [], `这些文件直接读取 .md：${offenders.join(', ')}`)
})

// ---- 3. 对外入口 -----------------------------------------------------------
check('入口闭包可解析，且只包含 src/ 下的源码', () => {
  const entries = new Set()
  if (typeof manifest.main === 'string') entries.add(manifest.main)
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') entries.add(value)
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string') entries.add(nested)
      }
    }
  }

  // `package.json` 是合法导出，但它是数据而非代码入口，不进闭包遍历。
  // 导出值写作 `./package.json`，比较前先归一化前导 `./`。
  const normalize = (entry) => entry.replace(/^\.\//u, '')
  const queue = [...entries]
    .filter((entry) => normalize(entry) !== 'package.json')
    .map((entry) => join(ROOT, entry))
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // 入口可能指向非源码资源，跳过。
    }
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)) {
      queue.push(join(file, '..', match[1]))
    }
  }
  assert.ok(seen.size > 0, '没有解析到任何入口文件，检查无意义')

  // 插件入口只能依赖 src/ 内的模块：任何指向仓库根（开发期草稿所在处）的依赖
  // 都会在此暴露，从而无法被发布产物之外的引用悄悄带入运行时。
  const outside = [...seen]
    .map((file) => relative(ROOT, file))
    .filter((path) => !path.startsWith(`src${sep}`))
  assert.deepEqual(outside, [], `入口闭包引用了 src/ 之外的文件：${outside.join(', ')}`)
})

check('cordis.patch.yml 指向的插件入口可解析', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'cordis.patch.yml 没有引用本包名')
  assert.ok(manifest.main.startsWith('src/'), `入口不在 src/ 下：${manifest.main}`)
  assert.ok(readFileSync(join(ROOT, manifest.main), 'utf8').length > 0, '插件入口为空')
})

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m打包/运行时隔离检查全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)