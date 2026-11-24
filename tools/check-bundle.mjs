/**
 * 插件包自检：装/升级之前先跑，专治「装了但左侧栏没出现」这一类。
 *
 * 用法：node tools/check-bundle.mjs
 *
 * 2026-11-23 的事故：改 package.json 时被 PowerShell 写进 UTF-8 BOM，
 * 插件管理器解析失败 → 静默把 bundle 行从 profile 组合里丢掉 → 重启后入口消失。
 * 这里把能判的几条焊死：JSON 可解析、清单字段齐、补丁行存在、图标可读、语法能过。
 */

import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(file) {
  const buffer = await readFile(file)
  assert.notEqual(buffer[0], 0xEF, `${file} 带 UTF-8 BOM（插件管理器会解析失败，bundle 行会静默丢失）`)
  const text = buffer.toString('utf8')
  try { return JSON.parse(text) } catch (error) { throw new Error(`${file} 不是合法 JSON：${error.message}`) }
}

async function main() {
  const manifest = await readJson(path.join(ROOT, 'package.json'))
  assert.equal(manifest.name, 'dsh-knowledge-base', '包名不对：' + manifest.name)
  assert.ok(manifest.dsh?.bundle?.patch, 'package.json 缺 dsh.bundle.patch')
  assert.ok(manifest.dsh?.client, 'package.json 缺 dsh.client（没有客户端就不会有左侧栏入口）')
  assert.equal(manifest.dsh.client.immediately, true, 'dsh.client.immediately 必须为 true')
  assert.ok(manifest.exports?.['./client'], 'exports 缺 ./client')
  assert.ok(manifest.exports?.['./icon'], 'exports 缺 ./icon')

  for (const language of ['zh', 'en']) {
    const locale = await readJson(path.join(ROOT, 'locale', `${language}.json`))
    assert.ok(locale.meta?.title, `locale/${language}.json 缺 meta.title`)
    assert.ok(locale.meta?.description, `locale/${language}.json 缺 meta.description`)
  }

  const patch = await readFile(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /insert:/, 'cordis.patch.yml 没有 insert 段')
  assert.match(patch, /id:\s*knowledge-base/, 'cordis.patch.yml 没有本插件那一行（id: knowledge-base）')
  assert.match(patch, /name:\s*dsh-knowledge-base/, 'cordis.patch.yml 的行名不对')

  for (const file of ['index.js', 'client.js', 'README.md', 'icon.svg']) {
    await access(path.join(ROOT, file), constants.R_OK).catch(() => { throw new Error('缺文件：' + file) })
  }
  const icon = await readFile(path.join(ROOT, 'icon.svg'), 'utf8')
  assert.match(icon, /<svg[^>]*viewBox/, 'icon.svg 不是可渲染的 SVG')

  for (const file of ['index.js', 'client.js']) {
    const check = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' })
    assert.equal(check.status, 0, `${file} 语法不过：${check.stderr?.slice(0, 300)}`)
  }

  const client = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  assert.match(client, /__ModuleLoader__\.load/, 'client.js 没按模块加载器约定注册 factory')
  assert.match(client, /id:\s*'dsh-knowledge-base'/, 'client.js 的 factory id 与包名不一致')
  assert.match(client, /sidebar\.panellist/, 'client.js 没注册左侧栏入口')

  
/* ── 版本号三处必须一致（2026-11-24 加）────────────────────
   版本号要手工改 index.js / client.js / package.json 三处；
   漏一处的表现是界面显示的版本和实际跑的不是同一个数，排查时白绕一圈。 */
{
  const hostSrc = await readFile(path.join(ROOT, 'index.js'), 'utf8')
  const clientSrc = await readFile(path.join(ROOT, 'client.js'), 'utf8')
  const hostVersion = /const VERSION = '([^']+)'/.exec(hostSrc)?.[1]
  const clientBuild = /const BUILD = '([^']+)'/.exec(clientSrc)?.[1]
  assert.ok(hostVersion, 'index.js 里没有 VERSION')
  assert.ok(clientBuild, 'client.js 里没有 BUILD')
  assert.equal(manifest.version, hostVersion, 'package.json 版本 ' + manifest.version + ' ≠ index.js VERSION ' + hostVersion)
  assert.equal(clientBuild, hostVersion, 'client.js BUILD ' + clientBuild + ' ≠ index.js VERSION ' + hostVersion)
  console.log('  版本一致：' + hostVersion + '（index.js / client.js / package.json）')
}

console.log('CHECK-BUNDLE OK — 清单/BOM/补丁行/图标/语法/入口注册 全部合规')
}

main().catch((error) => {
  console.error('CHECK-BUNDLE FAIL:', error?.message ?? error)
  process.exit(1)
})
