/**
 * 可移植性测试：模拟「另一台陌生机器」装上这个插件
 *
 * 做法：造一个临时目录，结构与开发机完全不同（没有额外的知识包目录、没有路由目录、
 * AGENTS.md 里没有「开工索引」表），只放一份 知识库.json 告诉它扫哪里。
 * 判据：装上不报错、能扫到文件、缺表时给说明而不是崩掉。
 *
 * 用法：node tools/test-portable.mjs
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const ROOT = path.join(os.tmpdir(), 'kb-portable-' + Date.now())
const LIB = path.join(ROOT, 'library')
const DSH = path.join(ROOT, 'other-dsh')
const WORK = path.join(ROOT, 'other-workspace')

function makeRes() {
  const state = { status: 0, body: '' }
  return { state, writeHead(s) { state.status = s }, end(c) { state.body += c ?? '' }, json() { return JSON.parse(state.body) } }
}

async function main() {
  await mkdir(LIB, { recursive: true })
  await mkdir(path.join(DSH, 'skills', 'sample-skill'), { recursive: true })
  await mkdir(path.join(WORK, 'docs'), { recursive: true })
  await mkdir(path.join(WORK, 'sub', 'deep'), { recursive: true })

  // 陌生人的 AGENTS.md：没有「开工索引」表，只有普通文字
  await writeFile(path.join(DSH, 'AGENTS.md'), '# 别人的全局指令\n\n这里没有开工索引表。\n', 'utf8')
  await writeFile(path.join(DSH, 'skills', 'sample-skill', 'SKILL.md'), '---\nname: sample-skill\ndescription: 别人的技能\n---\n\n正文\n', 'utf8')
  await writeFile(path.join(WORK, 'docs', '规则甲.md'), '# 规则甲\n\n正文\n', 'utf8')
  await writeFile(path.join(WORK, 'docs', '规则乙.md'), '# 规则乙\n\n' + 'x'.repeat(13000) + '\n', 'utf8')
  await writeFile(path.join(WORK, 'sub', 'deep', '笔记.md'), '# 笔记\n\n正文\n', 'utf8')

  // 只靠这份配置告诉插件从哪扫（不传 config.dshRoot/workspaceRoot）
  await writeFile(path.join(LIB, '知识库.json'), JSON.stringify({
    roots: { dsh: DSH, work: WORK },
    sources: [
      { cat: 'general', group: '全局指令', root: 'dsh', path: 'AGENTS.md' },
      { cat: 'general', group: '技能', root: 'dsh', path: 'skills', dir: true, only: 'SKILL.md' },
      { cat: 'general', group: '别人文档', root: 'work', path: 'docs', dir: true },
      { cat: 'general', group: '深层文档', root: 'work', path: 'sub/deep', dir: true },
    ],
  }, null, 2), 'utf8')

  const routes = new Map()
  apply({
    inject(services, callback) { callback({ webServer: { register(route) { routes.set(route.path, route) } } }) },
    effect(fn) { fn() },
  }, { libraryDir: LIB })

  const call = async (p) => {
    const route = routes.get(p.split('?')[0])
    assert.ok(route, '路由没注册：' + p)
    const res = makeRes()
    await route.handler({ method: 'GET', url: p, on() {} }, res)
    return { status: res.state.status, data: res.json() }
  }

  // 1. status：用的是配置里的根，不是我这台的真实根
  const status = await call('/plugins/dsh-knowledge-base/status')
  assert.equal(status.data.ok, true)
  assert.equal(path.normalize(status.data.roots.work), path.normalize(WORK), '没吃 知识库.json 的 work 根：' + status.data.roots.work)
  assert.equal(path.normalize(status.data.roots.dsh), path.normalize(DSH), '没吃 知识库.json 的 dsh 根：' + status.data.roots.dsh)
  assert.ok(String(status.data.configFile).includes('知识库.json'), 'status 没报配置文件位置')
  assert.equal(status.data.sources, 4, 'sources 数量应为配置里的 4 条：' + status.data.sources)

  // 2. index：扫得到、分类还是五类、超长文件标橙
  const index = await call('/plugins/dsh-knowledge-base/index?force=1')
  assert.ok(Array.isArray(index.data.items), '索引没返回 items')
  const titles = index.data.items.map((item) => item.title)
  for (const name of ['AGENTS', 'sample-skill', '规则甲', '规则乙', '笔记']) {
    assert.ok(titles.includes(name), '没扫到：' + name + '（实际：' + titles.join('/') + '）')
  }
  assert.equal(index.data.categories.length, 5, '分类应仍是五类')
  const big = index.data.items.find((item) => item.title === '规则乙')
  assert.equal(big.sizeStat, 'heavy', '超 1.2 万字文档应标橙：' + big.sizeStat)
  assert.ok(!index.data.warnings.some((line) => line.includes('不存在')), '根都存在时不该报路径不存在：' + index.data.warnings.join('|'))

  // 3. /routes：没有开工索引表 → 返回空行 + 说明，不许 404 或崩
  const table = await call('/plugins/dsh-knowledge-base/routes')
  assert.equal(table.status, 200, '/routes 不该返回错误码：' + table.status)
  assert.equal(table.data.rows.length, 0)
  assert.ok(/开工索引/.test(table.data.warning ?? ''), '/routes 应说明缺哪张表：' + table.data.warning)

  // 4. canvas：没有路由表也照画，文件与分类都在，只是没有路由线
  const canvas = await call('/plugins/dsh-knowledge-base/canvas')
  assert.equal(canvas.data.ok, true, '画布不该整幅报错：' + canvas.data.error)
  assert.ok(canvas.data.nodes.length >= 5, '画布节点太少：' + canvas.data.nodes.length)
  assert.equal(canvas.data.edges.filter((edge) => edge.kind === 'route').length, 0, '没有表就不该有路由线')
  assert.ok(canvas.data.nodes.some((node) => node.kind === 'cat'), '分类节点应在')
  assert.ok(/开工索引/.test(canvas.data.warning ?? ''), '画布应说明为什么没有路由线')

  // 5. 根配错时给 warnings（不是白屏）
  await writeFile(path.join(LIB, '知识库.json'), JSON.stringify({
    roots: { dsh: DSH, work: path.join(ROOT, 'not-exist') },
    sources: [{ cat: 'general', group: 'X', root: 'dsh', path: 'AGENTS.md' }],
  }, null, 2), 'utf8')
  const badRoutes = new Map()
  apply({
    inject(services, callback) { callback({ webServer: { register(route) { badRoutes.set(route.path, route) } } }) },
    effect(fn) { fn() },
  }, { libraryDir: LIB })
  const badRes = makeRes()
  await badRoutes.get('/plugins/dsh-knowledge-base/status').handler({ method: 'GET', url: '/plugins/dsh-knowledge-base/status', on() {} }, badRes)
  const badStatus = badRes.json()
  assert.ok(badStatus.warnings.some((line) => line.includes('不存在')), '根不存在时应给 warnings：' + badStatus.warnings.join('|'))

  await rm(ROOT, { recursive: true, force: true })
  console.log('TEST-PORTABLE OK — 陌生目录结构：根走配置、没表不崩、超长标橙、配置错给提示（5 组断言全过）')
}

main().catch(async (error) => {
  console.error('TEST-PORTABLE FAIL:', error?.message ?? error)
  try { await rm(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
