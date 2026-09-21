#!/usr/bin/env node
/**
 * 硬约束「记忆按项目维度隔离」的专项验证。
 *
 * 覆盖三类容易漏掉的串味场景：
 *   1. 同一路径的不同写法（相对路径、尾斜杠、`..` 回环）必须解析到同一处 ——
 *      否则同一个项目会因为调用方式不同而分裂成多份记忆；
 *   2. 基名相同的不同目录必须解析到不同处 —— 这是最常见的一种「看起来一样、
 *      其实是两个项目」的碰撞；
 *   3. 一个项目的写入不得改变另一个项目的内容。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-pm-isolation-'))
const env = { ...process.env, DSH_HOME: join(sandbox, 'dsh-home') }

/** 在独立进程里解析一个项目路径的记忆根目录。 */
const resolveFor = (projectPath, cwd) =>
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { resolveProjectMemoryPaths } from '${ROOT}/src/store.js'
       process.stdout.write(resolveProjectMemoryPaths(${JSON.stringify(projectPath)}).root)`,
    ],
    { env, encoding: 'utf8', cwd },
  ).trim()

process.stdout.write('\n硬约束：项目维度隔离\n')

// 两个基名相同、父目录不同的项目 —— 最容易发生碰撞的形状。
const parentX = mkdtempSync(join(sandbox, 'x-'))
const parentY = mkdtempSync(join(sandbox, 'y-'))
const projectX = join(parentX, 'same-name')
const projectY = join(parentY, 'same-name')
execFileSync('mkdir', ['-p', projectX, projectY])

const rootX = resolveFor(projectX, sandbox)
const rootY = resolveFor(projectY, sandbox)

check('基名相同、父目录不同的两个项目解析到不同记忆目录', () => assert.notEqual(rootX, rootY))

check('同一路径的相对写法解析到同一记忆目录', () => {
  assert.equal(resolveFor('./same-name', parentX), rootX, '相对路径与绝对路径不一致')
  const withDotDot = resolveFor(join(parentX, '..', parentX.split('/').pop(), 'same-name'), sandbox)
  assert.equal(withDotDot, rootX, '含 .. 回环的路径不一致')
})

check('同一路径带尾斜杠解析到同一记忆目录', () => {
  assert.equal(resolveFor(`${projectX}/`, sandbox), rootX)
})

check('写入一个项目不改变另一个项目的内容', () => {
  const script = `
    import { resolveProjectMemoryPaths, ProjectMemoryStore, readMemoryFileStable } from '${ROOT}/src/store.js'
    const x = resolveProjectMemoryPaths(${JSON.stringify(projectX)})
    const y = resolveProjectMemoryPaths(${JSON.stringify(projectY)})
    const sx = new ProjectMemoryStore(x)
    const sy = new ProjectMemoryStore(y)
    await sx.save({ key: 'X', content: 'X_VALUE' })
    const yAfter = await readMemoryFileStable(y.indexFilePath)
    await sy.save({ key: 'Y', content: 'Y_VALUE' })
    const xAfter = await sx.readIndex()
    process.stdout.write(JSON.stringify({
      yExistsAfterXWrite: yAfter.exists,
      xHasYValue: xAfter.content.includes('Y_VALUE'),
      xHasXValue: xAfter.content.includes('X_VALUE'),
    }))
  `
  const out = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf8',
      cwd: ROOT,
    }),
  )
  assert.equal(out.yExistsAfterXWrite, false, '写 X 之后 Y 竟然有了索引')
  assert.equal(out.xHasYValue, false, '写 Y 之后 X 读到了 Y 的内容')
  assert.equal(out.xHasXValue, true, 'X 自己的内容丢了')
})

check('未产生记忆文件时读取是安全的（返回空而非抛错）', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readMemoryFileStable } from '${ROOT}/src/store.js'
       const s = await readMemoryFileStable(${JSON.stringify(join(sandbox, 'nope', 'MEMORY.md'))})
       process.stdout.write(JSON.stringify(s))`,
    ],
    { env, encoding: 'utf8', cwd: ROOT },
  ).trim()
  const parsed = JSON.parse(out)
  assert.equal(parsed.exists, false)
  assert.equal(parsed.content, '')
})

rmSync(sandbox, { recursive: true, force: true })

process.stdout.write(
  failures === 0
    ? '\n\u001B[32m隔离检查全部通过\u001B[0m\n'
    : `\n\u001B[31m${failures} 项失败\u001B[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
