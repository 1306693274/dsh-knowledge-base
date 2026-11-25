/**
 * 知识库（dsh-knowledge-base）
 *
 * 定位：把规则 / 流程 / 技能 / 阀门 / 路由汇总到一个页面里就地查看和修改。
 * 硬约束：**不复制、不建副本**——库里只存索引、关联、快照、布局；正文永远是磁盘上原来那份文件。
 *
 * 收录口径：
 *   core = 规则 / 流程 / 口径 / 知识 / 经验 / 技能 / 索引 / 阀门 —— 默认可见
 *   ref  = 原始简报 / 学习摘录 / 案例实测 / 报告 / 日志 / 项目交付 / 外部收藏 —— 默认隐藏
 * 归属（领域）：design 平面视觉 / dynamic 动态影像 / finance 金融 / assistant 助手（社交·采集·网页·机器人）/ general 其余
 *   分类表与领域词可被 `~\.dsh\知识库\分类.json` 覆盖（以后新增 Agent 只改配置文件）。
 */

import { readFile, writeFile, mkdir, readdir, stat, copyFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-knowledge-base'
export const inject = []

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const GUIDE_FILE = path.join(PLUGIN_DIR, 'docs', 'AI-接入指南.md')

const state = { warnings: [] }
const ROUTE = '/plugins/dsh-knowledge-base'
const VERSION = '0.25.0'
const MAX_FILES = 8000
// 文件体量阈值（字符数）：超过 HEAVY_CHARS 标红，提示「AI 读全文容易执行不到位，该精简」
const HEAVY_CHARS = 12000
// 硬上限：AGENTS.md 超过 agent-instructions 的 maxBytes 会被静默截尾（这一类 100% 出问题 → 红圈）
const HARD_AGENTS_BYTES = 65536
// 硬上限：SKILL.md 的 description 超 500 字会被截断（audit-skills-rules.mjs 第 7 类已在判）
const HARD_SKILL_DESC = 500
const SKIP_DIRS = new Set([
  'node_modules', '.venv', '__pycache__', 'backups', '.git', '.runtime',
  'site-packages', 'dist', '.dsh-link', 'venvs', 'cache', 'runs',
])
const SKIP_DIR_PATHS = [
  '05-新电脑配置', '14-技能归档-2026-11-14', '技能归档', '15-外部参考',
  '工具与归档', '历史对话（脱敏）',
]

/* ── 小工具 ───────────────────────────────────────────────── */

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { try { resolve(Buffer.concat(chunks).toString('utf8')) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}

function encodeId(rootKey, relPath) {
  return Buffer.from(`${rootKey}|${relPath}`, 'utf8').toString('base64url')
}

/** 根解析：rootKey 既可以是内置名（dsh/pkg/work），也可以是绝对路径（多项目文件夹） */
function resolveRoot(roots, rootKey) {
  if (!rootKey) return ''
  if (path.isAbsolute(String(rootKey))) return String(rootKey)
  return roots[rootKey] ?? ''
}

/** 扫一遍候选知识目录（路由与 auto 接线共用同一套判据） */
function discoveredFor(roots, overrideBases) {
  const bases = []
  if (overrideBases?.length) bases.push(...overrideBases)
  else for (const key of ['work', 'pkg']) if (roots[key]) bases.push(roots[key])
  if (!overrideBases?.length) {
    const home = os.homedir()
    for (const name of ['Documents', 'Desktop', 'Projects', 'workspace', 'code', 'dev']) {
      const guess = path.join(home, name)
      if (existsSync(guess)) bases.push(guess)
    }
  }
  const skip = /^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|out|target|\.next|\.cache|backups|history|logs)$/i
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > 3 || found.length > 300) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    let md = 0
    let hasAgents = false
    let skillDirs = 0
    for (const entry of entries) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
  md += 1
  if (/^AGENTS\.md$/i.test(entry.name)) hasAgents = true
      }
      if (entry.isDirectory() && /^(skills|技能)$/i.test(entry.name)) skillDirs += 1
    }
    if (md >= 2 || hasAgents || skillDirs) {
      const key = dir.toLowerCase()
      if (!seen.has(key)) {
  seen.add(key)
  found.push({ path: dir, md, hasAgents, hasSkills: Boolean(skillDirs), depth })
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (skip.test(entry.name) || entry.name.startsWith('.')) continue
      // 第三方仓库/工具自带的文档目录不算「你的知识」（没有 AGENTS.md 时跳过）
      if (/^(docs?|文档|references?|参考|examples?|示例|samples?|sites?|wiki)$/i.test(entry.name)) continue
      walk(path.join(dir, entry.name), depth + 1)
    }
  }
  for (const base of bases) if (base && existsSync(base)) walk(base, 0)
  // 被上层目录覆盖的深层候选去掉（父目录已经是一条 source 时，子目录重复没意义）
  const covered = (inner, outer) => inner !== outer && inner.toLowerCase().startsWith(outer.toLowerCase().replace(/[\\/]+$/, '') + path.sep.toLowerCase())
  const pruned = found.filter((item) => !found.some((other) => other !== item && other.md >= item.md && covered(item.path, other.path)))
  pruned.sort((left, right) => right.md - left.md)

  return pruned.map((item) => ({ ...item, cat: inferCat(item.path, path.basename(item.path), 'general').cat }))
}
function decodeId(id) {
  const raw = Buffer.from(String(id), 'base64url').toString('utf8')
  const index = raw.indexOf('|')
  if (index < 0) throw new Error('bad-id')
  return { rootKey: raw.slice(0, index), relPath: raw.slice(index + 1) }
}

function safeJoin(base, rel) {
  const target = path.resolve(base, rel)
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('path-escape')
  return target
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/* ── 逻辑根：两台电脑盘符不同，按 本机路径.md 解析 ───────── */

function readPathTable(dshRoot) {
  const file = path.join(dshRoot, '本机路径.md')
  const table = {}
  if (!existsSync(file)) return table
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^[-\s*]*[^\s=]+[^=]*=\s*`?([A-Za-z]:[\\/][^`\n]*)`?/)
      if (!match) continue
      if (/\bPKG\b/.test(line)) table.pkg = match[1].trim()
      else if (/\bIMPORTANT\b/.test(line)) table.important = match[1].trim()
      else if (/\bWORK\b/.test(line)) table.work = match[1].trim()
      else if (/\bDSH\b/.test(line)) table.dsh = match[1].trim()
      else if (/\bMNEMON\b/.test(line)) table.mnemon = match[1].trim()
    }
  } catch { /* 读不出来就退回默认 */ }
  return table
}

/* ── 分类与来源 ───────────────────────────────────────────── */

const DEFAULT_CATEGORIES = [
  { id: 'general', label: '通用' },
  { id: 'design', label: '设计 Agent' },
  { id: 'dynamic', label: '动态 Agent' },
  { id: 'assistant', label: '助手 Agent' },
  { id: 'finance', label: '金融 Agent' },
]

let CATEGORIES = DEFAULT_CATEGORIES.slice()

const DEFAULT_SOURCES = [
  // 这是一份「最小示例」：真正的目录用 ~/.dsh/知识库/知识库.json 配（见 docs/AI-接入指南.md）。
  // 不配也能跑：会扫下面这几处，其余分类为空，界面会提示哪个根没接上。
  { cat: 'general', group: '全局指令', root: 'dsh', path: 'AGENTS.md' },
  { cat: 'general', group: '全局技能', root: 'dsh', path: 'skills', dir: true, only: 'SKILL.md' },
  { cat: 'general', group: '规则', root: 'pkg', path: 'rules', dir: true },
  { cat: 'general', group: '经验', root: 'pkg', path: 'notes', dir: true },

  // 每个 Agent 一类：把它的目录配到对应 cat 上即可（Agent 多了就在 分类.json 里加一条）
  { cat: 'design', group: '根目录规则与流程', root: 'work', path: 'design-agent', dirOnly: true },
  { cat: 'design', group: '技能', root: 'work', path: 'design-agent/skills', dir: true, only: 'SKILL.md' },
  { cat: 'dynamic', group: '根目录规则与流程', root: 'work', path: 'dynamic-agent', dirOnly: true },
  { cat: 'dynamic', group: '技能', root: 'work', path: 'dynamic-agent/skills', dir: true, only: 'SKILL.md' },
  { cat: 'assistant', group: '根目录规则与流程', root: 'work', path: 'assistant-agent', dirOnly: true },
  { cat: 'assistant', group: '技能', root: 'work', path: 'assistant-agent/skills', dir: true, only: 'SKILL.md' },
  { cat: 'finance', group: '根目录规则与流程', root: 'work', path: 'finance-agent', dirOnly: true },
]

/* ── 归属推断：按领域判，不是一个词表 ─────────────────────── */

// 运行时可变：由 ~/.dsh/知识库/知识库.json 覆盖（别人的目录结构和我不一样，换机器只改配置不改代码）
let SOURCES = DEFAULT_SOURCES.slice()

const DEFAULT_DOMAIN_KEYWORDS = [
  // 示例词表：按需要改成你自己的领域词（正则源字符串，顺序即优先级）
  { cat: 'design', pattern: /封面|海报|主视觉|版式|配色|字体|logo|PSD|图片|修图|出图/, reason: '静态视觉交付物 → 平面视觉' },
  { cat: 'design', pattern: /design|poster|layout|cover|palette/i, reason: '命名指向平面视觉领域' },
  { cat: 'dynamic', pattern: /视频|动画|分镜|运镜|剪辑|渲染|建模|三维|\b3D\b|C4D|Blender/, reason: '命名指向动态影像领域' },
  { cat: 'dynamic', pattern: /video|anim|render|motion|timeline/i, reason: '命名指向动态影像领域' },
  { cat: 'finance', pattern: /交易|投研|行情|财报|量化|回测|策略|仓位|K线|股票|基金/, reason: '命名指向金融领域' },
  { cat: 'finance', pattern: /trading|market|quant|portfolio/i, reason: '命名指向金融领域' },
  { cat: 'assistant', pattern: /社交|采集|抓取|网页|浏览器|机器人|搜索|收藏/, reason: '命名指向助手（社交/采集/网页/机器人）领域' },
  { cat: 'assistant', pattern: /scrap|crawl|browser|bot|collect/i, reason: '命名指向助手领域' },
]

const DOMAIN_CONFIG_VERSION = 2
let DOMAIN_KEYWORDS = DEFAULT_DOMAIN_KEYWORDS.slice()

function inferCat(rel, baseName, fallback) {
  const text = baseName + ' ' + rel
  for (const hint of DOMAIN_KEYWORDS) if (hint.pattern.test(text)) return { cat: hint.cat, reason: hint.reason }
  return { cat: fallback, reason: '' }
}

/** 自检用：给定路径与文件名，返回它会被归到哪个领域 */
export function __inferCat(rel, baseName, fallback = 'general') {
  return inferCat(rel, baseName, fallback)
}

/** 自检用：等分类.json 加载完（异步），确保测的是真机同一套词表 */
export async function __loadDomainConfig(libraryDir) {
  await loadDomainConfig(libraryDir ?? path.join(os.homedir(), '.dsh', '知识库'))
}

/** 自检用：当前生效的分类表 */
export function __categories() {
  return CATEGORIES.map((item) => ({ ...item }))
}

/**
 * 读用户配置的分类文件，覆盖分类表与领域词（以后新增 Agent 只改这个 JSON）。
 * keywords 支持数组（推荐，顺序即优先级）或对象；文件不存在时按默认值自动生成一份。
 */
async function loadDomainConfig(libraryDir) {
  const file = path.join(libraryDir, '分类.json')
  try {
    await mkdir(libraryDir, { recursive: true })
    if (!existsSync(file)) {
      const template = {
        _说明: '改这个文件就能新增 Agent 分类或调整领域词；改完在知识库里点「重新扫描」。keywords 顺序即优先级（先匹配到的算）。',
        _defaultsVersion: DOMAIN_CONFIG_VERSION,
        categories: DEFAULT_CATEGORIES,
        keywords: DEFAULT_DOMAIN_KEYWORDS.map((item) => ({ cat: item.cat, pattern: item.pattern.source, reason: item.reason })),
      }
      await writeFile(file, JSON.stringify(template, null, 2) + '\n', 'utf8')
      return
    }
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (Array.isArray(data.categories) && data.categories.length) {
      CATEGORIES = data.categories.map((item) => ({ id: String(item.id), label: String(item.label) }))
    }
    // 词表有升级 → 用代码里的最新默认词（用户自己加的分类保留；用户的领域词自定义会被默认词覆盖，属预期）
    if (data._defaultsVersion !== DOMAIN_CONFIG_VERSION) {
      DOMAIN_KEYWORDS = DEFAULT_DOMAIN_KEYWORDS.slice()
      const next = {
        _说明: data._说明 ?? '改这个文件就能新增 Agent 分类或调整领域词；改完在知识库里点「重新扫描」。',
        _defaultsVersion: DOMAIN_CONFIG_VERSION,
        categories: data.categories ?? DEFAULT_CATEGORIES,
        keywords: DEFAULT_DOMAIN_KEYWORDS.map((item) => ({ cat: item.cat, pattern: item.pattern.source, reason: item.reason })),
      }
      await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
      return
    }
    if (Array.isArray(data.keywords) && data.keywords.length) {
      DOMAIN_KEYWORDS = data.keywords.map((entry) => ({
        cat: String(entry.cat),
        pattern: new RegExp(String(entry.pattern), 'i'),
        reason: String(entry.reason ?? '配置文件指定'),
      }))
    } else if (data.keywords && typeof data.keywords === 'object') {
      DOMAIN_KEYWORDS = Object.entries(data.keywords).map(([cat, entry]) => ({
        cat,
        pattern: new RegExp(String(entry.pattern), 'i'),
        reason: String(entry.reason ?? '配置文件指定'),
      }))
    }
  } catch (error) {
    console.log('[knowledge-base] 分类.json 读不了，按默认分类走：', error?.message)
  }
}

/* ── 插件实体：从「插件归属」文档的表格里抽出来 ─────────── */

function parsePluginRows(body) {
  const found = []
  let section = ''
  const prose = (cell) => {
    const text = String(cell ?? '').replace(/`/g, '').replace(/\*\*/g, '').trim()
    if (text.length < 6 || text.length > 200) return ''
    if (/^[A-Za-z]:\\/.test(text)) return ''
    if (/\\/.test(text) || /^</.test(text)) return '' // 装在哪 / 路径 那一类不算说明
    if (/:\s/.test(text) || /=\{/.test(text)) return ''
    if (!/\p{Script=Han}/u.test(text)) return ''
    return text
  }
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^##+\s+(.*)$/)
    if (heading) { section = heading[1]; continue }
    if (!/独占的插件|MCP 连接|本地插件文件|全局已装的插件包|靠全局插件/.test(section)) continue
    if (/技能|工具|怎么核|怎么改|不独占/.test(section.replace(/独占的插件|靠全局插件/, ''))) continue
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    if (/^:?-{2,}/.test(cells[0] ?? '')) continue
    const idMatch = cells[0].match(/`([^`]+)`/)
    if (!idMatch) continue
    if (/技能/.test(cells[0])) continue // 第一格写着「技能」的是技能不是插件
    const id = idMatch[1].trim()
    if (id.length < 3 || /\s/.test(id) || /^\d/.test(id)) continue
    // 说明文字：4 列取第 3 列（干什么）；3 列若第 3 列很短（像「谁在用」）就取第 2 列
    const third = prose(cells[2])
    const second = prose(cells[1])
    let desc = cells.length === 3
      ? (third.length > 10 ? third : (second || third))
      : (third || second || cells.slice(3).map(prose).filter(Boolean).sort((left, right) => right.length - left.length)[0] || '')
    if (!desc) desc = cells.slice(1).map(prose).filter(Boolean).sort((left, right) => right.length - left.length)[0] ?? ''
    if (desc.length > 160) desc = desc.slice(0, 160) + '…'
    found.push({ id, desc })
  }
  return found
}

/**
 * 读 知识库.json：这份配置管「扫哪些根、扫哪些目录」，让插件在别人机器上也能用。
 * 同步读：根必须在注册路由之前就定下来；文件很小，没有性能问题。
 * 结构：
 *   { "roots": { "dsh": "...", "pkg": "...", "work": "..." },
 *     "sources": [ { "cat": "general", "group": "跨领域铁律", "root": "dsh", "path": "AGENTS.md" }, ... ] }
 * 缺文件时：根按「本机路径.md」解析，来源用默认表。
 */
const LIBRARY_CONFIG_EXAMPLE = {
  _说明: '把这份文件复制成 知识库.json 就能改「从哪扫」：roots 是三个根，sources 是每个目录归到哪类。不复制就用默认来源（内置的那套）。',
  _字段: ["cat：general / design / dynamic / assistant / finance 之一", "root：dsh / pkg / work 之一", "path 或 paths：相对该根的目录或文件", "dir: true 表示按目录递归收 .md；dirOnly: true 只收该目录根部的 .md", "only: 只收这个文件名（例如 SKILL.md）"],
  roots: { dsh: "<本机 ~/.dsh 的绝对路径>", pkg: "<同步盘知识包根>", work: "<工作区根>" },
  sources: [
    { cat: 'general', group: '跨领域铁律', root: 'dsh', path: 'AGENTS.md' },
    { cat: 'general', group: '全局技能', root: 'dsh', path: 'skills', dir: true, only: 'SKILL.md' },
    { cat: 'general', group: '我的文档', root: 'work', path: 'docs', dir: true },
  ],
}

function readLibraryConfigSync(libraryDir) {
  const file = path.join(libraryDir || '', '知识库.json')
  if (!file || !existsSync(file)) {
    // 顺手放一份示例：别人装完照着改，不用读源码
    try {
      const example = path.join(libraryDir || '', '知识库.json.example')
      if (libraryDir && existsSync(path.dirname(example)) && !existsSync(example)) {
        writeFileSync(example, JSON.stringify(LIBRARY_CONFIG_EXAMPLE, null, 2) + "\n", "utf8")
      }
    } catch { /* 写不了就不写，不影响扫描 */ }
    return {}
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const out = {}
    if (data && typeof data.roots === "object" && data.roots) {
      out.roots = {}
      // 任意键都收：多项目文件夹可以写 roots.projectA / roots.projectB……
      // 内置三个（dsh / pkg / work）只是默认名，不是白名单。
      for (const [key, value] of Object.entries(data.roots)) {
        if (typeof value === "string" && value.trim()) out.roots[key] = value.trim()
      }
    }
    if (data && Array.isArray(data.sources) && data.sources.length) {
      out.sources = data.sources
        .filter((row) => row && typeof row === "object" && (typeof row.path === "string" || Array.isArray(row.paths)))
        .map((row) => ({ ...row, cat: String(row.cat ?? 'general'), group: String(row.group ?? '其他') }))
    }
    return out
  } catch (error) {
    console.log('[knowledge-base] 知识库.json 读不了，按默认配置走：', error?.message)
    return {}
  }
}

/* ── 收录判定（core 默认可见 / ref 默认隐藏） ─────────────── */

const REF_PATH_RULES = [
  [/_原始简报|\\raw\\|\/raw\//, '原始简报：外部文章的原文摘录，不是规则'],
  [/_写生|临时|草稿|待复核/, '草稿/待复核，还没成为规则'],
  [/07-对话提炼/, '对话提炼稿：是一段对话的摘要，不是规则'],
  [/16-项目工作/, '项目交付物：某一次活的产物，不是通用规则'],
  [/B站产品动画收藏/, '外部收藏清单：素材来源，不是规则'],
  [/TradingAgents-astock|WeChat-robot|dsh-wechat-robot/, '第三方项目自带文档，不是你的规则'],
  [/\bissues\/|\bTODO\.md|CLAUDE\.md|DEV_LOG|CHANGES_FROM_UPSTREAM/, '第三方开发过程记录'],
  [/aget|\bcodex改说明书\b|DLSS5Tool_Plus|外发/, '素材库/外发目录，不是规则'],
]

// 例外：落在上面这些目录里、但确实是规则的少数文件（按文件名放行）
const CORE_EXCEPTIONS = [
  /判据与规则\.md$/,
  /插件清单\.md$/,
  /插件与工具归属\.md$/,
  /插件归属总表\.md$/,
]

const REF_NAME_RULES = [
  [/^LICENSE|^THIRD_PARTY|^CHANGELOG|^DEV_LOG|^CLAUDE\.md|^TODO\.md|^README_en/, '仓库自带说明/许可文件'],
  [/案例与实测/, '实测证据：判断依据的出处，不是规则'],
  [/^_清单\.md$|入围作品清单|入选笔记清单|已精读清单|收藏夹映射|类目总表|关键词矩阵|插件清单|参考清单模板|读图记录表|待修正清单/, '外部条目清单/索引，不是规则'],
  [/分片\d/, '对话分片：一次对话的记录，不是规则'],
  [/简报|摘录|学习|笔记|素材|灵感/, '学习摘录/素材，不是规则'],
  [/^报告|报告$|可行性报告|分析报告|审计报告|还原报告|对比报告|插件对比|对比表|Vplugins逆向分析|逆向分析报告/, '一次性的报告/记录'],
  [/复盘|记录表|汇总待审|^\d{4}-\d\d-\d\d$/, '一次性的记录/汇总'],
  [/更新日志|版本归档|更新记录|修复说明|交付说明|分镜表|恢复记录|发布说明|CHANGELOG/, '变更记录/交付记录'],
  [/使用说明|安装说明|对外-|_使用|issue正文|豆包任务|任务单|任务书|^账号\.md$/, '说明书/任务单/账号资料，不进规则层'],
]

const CORE_TYPE_RULES = [
  [/插件清单|插件与工具归属|插件归属总表/, '插件'],
  [/^(AGENTS\.md|本机路径\.md)$|^00-总索引|^00-索引|^00-总览|^\d\d?-(总索引|总览)/, '索引'],
  [/SKILL\.md$/, '技能'],
  [/规矩|规则|铁律|口径|规范|标准|判据/, '规则'],
  [/流程|SOP|工作流|做法|手法|配方|步骤|路由/, '流程'],
  [/经验|坑|备忘|实测结论/, '经验'],
  [/清单$|^\d\d-/, '知识'],
]

const REF_TYPE_BY_NAME = [
  [/案例与实测/, '证据'],
  [/简报|摘录|干货|笔记|学习/, '摘录'],
  [/报告|复盘|汇总/, '报告'],
  [/更新日志|版本归档|更新记录|交付说明|分镜表|恢复记录|日志/, '记录'],
  [/清单|映射|类目总表|关键词矩阵/, '清单'],
]

function classify(rel, baseName) {
  // 白名单例外：这些文件在「参考层」目录里也属于规则层，但类型仍按后面的规则判
  const forced = CORE_EXCEPTIONS.some((pattern) => pattern.test(baseName))
  if (!forced) {
    for (const [pattern, reason] of REF_PATH_RULES) {
      if (pattern.test(rel)) return { kind: 'ref', reason, type: refType(baseName) }
    }
    for (const [pattern, reason] of REF_NAME_RULES) {
      if (pattern.test(baseName)) return { kind: 'ref', reason, type: refType(baseName) }
    }
  }
  let type = ''
  for (const [pattern, candidate] of CORE_TYPE_RULES) {
    if (pattern.test(baseName) || pattern.test(rel)) { type = candidate; break }
  }
  if (!type) type = /README|目录说明|总索引|总纲|总览/.test(baseName) ? '索引' : '知识'
  return { kind: 'core', reason: forced ? '规则层（白名单例外）' : '规则/流程/知识层', type }
}

function refType(baseName) {
  for (const [pattern, type] of REF_TYPE_BY_NAME) if (pattern.test(baseName)) return type
  return '参考'
}

/* ── 文件收集 ─────────────────────────────────────────────── */

/* 额外排除（2026-11-24 加）：~/.dsh/知识库/排除.json 的 dirFragments，路径命中片段即跳过。
   用途：① 自动重建的临时产物（07-对话提炼 每轮导出会重写，拆了也会被覆盖）
        ② 原始文章 raw / 日志 / 版本归档这类过程材料。
   注：从 0.25.0 起拆分卷（`*_分卷`）不再排除——它们进索引（volume:true）好让主文件里的
   卷按钮能按 id 打开，但不进左侧列表、不计数。 */
const DEFAULT_EXCLUDE_PARTS = ['07-对话提炼']
let EXCLUDE_PARTS = DEFAULT_EXCLUDE_PARTS.slice()
let EXCLUDE_LOADED = false
let LIB_DIR = ''

let EXCLUDE_STAMP = null

function loadExcludeParts(libraryDir) {
  // 支持热改：排除.json 的 mtime 变了就重读，改完点「重新扫描」即可，不必重启
  const file = path.join(libraryDir || '', '排除.json')
  let stamp = 0
  try { stamp = existsSync(file) ? statSync(file).mtimeMs : 0 } catch { stamp = 0 }
  if (EXCLUDE_LOADED && stamp === EXCLUDE_STAMP) return
  EXCLUDE_STAMP = stamp
  EXCLUDE_LOADED = true
  try {
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(raw?.dirFragments)) {
      // 片段统一成"/"分隔、去掉首尾斜杠，写 \更新日志.md / 更新日志.md / /更新日志.md 都能命中
      EXCLUDE_PARTS = raw.dirFragments
        .map((s) => String(s).replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    }
  } catch (error) {
    console.log('[knowledge-base] 排除.json 读不了，用内置默认排除：', error?.message)
  }
}

function skippedDir(name, full) {
  if (!EXCLUDE_LOADED) loadExcludeParts(LIB_DIR)
  const fullNorm = String(full).replace(/\\/g, '/')
  // 拆分卷无条件收录（2026-11-24，0.25.0）：它们不进左侧列表（client 按 volume 过滤），
  // 但必须有 id，主文件页顶部的「卷」按钮和小标题链接才能打开；因此不受排除清单影响。
  // 这样也兼容旧版插件：旧代码不认识 volume，靠 排除.json 里的 `_分卷` 保持列表干净。
  if (/(^|\/)[^/]*_分卷(\/|$)/.test(fullNorm)) return false
  if (EXCLUDE_PARTS.some((fragment) => fragment && fullNorm.includes(fragment))) return true
  if (SKIP_DIRS.has(name)) return true
  return SKIP_DIR_PATHS.some((fragment) => full.includes(fragment))
}

async function listMarkdown(dir, { only, depth = 0 } = {}) {
  const out = []
  if (depth > 8) return out
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.dsh-link') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skippedDir(entry.name, full)) continue
      out.push(...await listMarkdown(full, { only, depth: depth + 1 }))
      if (out.length > MAX_FILES) return out
      continue
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    if (skippedDir(entry.name, full)) continue
    if (only) {
      const wanted = Array.isArray(only) ? only : [only]
      if (!wanted.includes(entry.name)) continue
    }
    out.push(full)
  }
  return out
}

async function listRootMarkdown(dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

const DOC_LIKE = /\.(md|mjs|cjs|js|ps1|cmd|json)$/i

function isDocToken(token) {
  const text = String(token).trim()
  if (!text) return false
  if (text.startsWith('-') || text.startsWith('.') || text.startsWith('=')) return false
  if (/[()=<>，。！？]/.test(text)) return false
  if (/\s/.test(text)) return false
  if (DOC_LIKE.test(text)) return true
  return /[\\/]/.test(text)
}

/* ── 用户覆盖：一条条改分类 / 改收录层 ───────────────────── */

function overridesFile(libraryDir) { return path.join(libraryDir, '分类覆盖.json') }

async function readOverrides(libraryDir) {
  const file = overridesFile(libraryDir)
  if (!existsSync(file)) return {}
  try { return JSON.parse(await readFile(file, 'utf8')) ?? {} } catch { return {} }
}

async function writeOverrides(libraryDir, overrides) {
  await mkdir(libraryDir, { recursive: true })
  await writeFile(overridesFile(libraryDir), JSON.stringify(overrides, null, 2), 'utf8')
}

/* ── 扫描索引 ─────────────────────────────────────────────── */

const cache = { at: 0, payload: null }

/* 陌生机器兜底（2026-11-25 加，用户要求「别人装了也能正常用」）：
   默认清单 DEFAULT_SOURCES 写的是作者那台机器的目录名；别人装完这些目录一个都不存在，
   列表会是空的。这里对「清单里一条都不存在的根」自动发现候选目录（用 /discover 同一套判据），
   按目录名推断分类。作者自己的机器上清单里的目录都在 → 这段完全不触发。 */
function effectiveSources(roots) {
  const present = []
  const coveredRoots = new Set()
  for (const source of SOURCES) {
    const base = path.isAbsolute(String(source.root ?? '')) ? source.root : roots[source.root]
    if (!base) continue
    // 判「这条 source 在这台机器上真的存在」要看 根+path（paths 数组任一存在即可），
    // 只看根是不够的 —— 陌生机器上根在、但清单里的目录名一个都没有。
    const targets = source.paths?.length
      ? source.paths.map((p) => path.join(base, String(p)))
      : [source.path ? path.join(base, String(source.path)) : base]
    if (targets.some((t) => existsSync(t))) { present.push(source); coveredRoots.add(source.root) }
  }
  // 某个根在清单里一条 source 都没有（或全都不存在）→ 说明这是别人机器，自动发现
  for (const key of ['work', 'pkg', 'dsh']) {
    if (coveredRoots.has(key)) continue
    if (key === 'dsh') continue // ~/.dsh 有固定结构（AGENTS.md / skills），走内置清单，不做猜测
    const root = roots[key]
    if (!root || !existsSync(root)) continue
    let candidates = []
    try { candidates = discoveredFor({ [key]: root }, [root]) } catch { candidates = [] }
    for (const cand of candidates.slice(0, 30)) {
      const rel = path.relative(root, cand.path).split(path.sep).join('/')
      present.push({ cat: cand.cat, group: path.basename(cand.path), root: key, path: rel || '.', dir: true })
    }
    if (candidates.length) console.log(`[knowledge-base] 根「${key}」里没有默认清单的目录，自动发现 ${candidates.length} 个候选`)
  }
  return present
}

async function scanIndex(roots, libraryDir, { force = false } = {}) {
  const now = Date.now()
  if (!force && cache.payload && now - cache.at < 15000) return cache.payload
  LIB_DIR = libraryDir || LIB_DIR
  const overrides = await readOverrides(libraryDir)

  const items = []
  const sourcesToScan = effectiveSources(roots)
  for (const source of sourcesToScan) {
    const base = path.isAbsolute(String(source.root ?? '')) ? source.root : roots[source.root]
    if (!base || !existsSync(base)) continue
    const push = (absPath) => {
      const rel = path.relative(base, absPath).split(path.sep).join('/')
      const baseName = path.basename(absPath)
      const title = /^SKILL\.md$/i.test(baseName) ? path.basename(path.dirname(absPath)) : baseName.replace(/\.md$/i, '')
      const decided = classify(rel, baseName)
      const id = encodeId(source.root, rel)
      const override = overrides[id]
      const inferred = inferCat(rel, baseName, source.cat)
      items.push({
        id,
        rootKey: source.root,
        rel,
        // 2026-11-24：拆分卷（`X_分卷\01.md`）也进索引，这样主文件里的卷链接能按 id 打开；
        // 但它不进列表、不算分类计数（client 用 volume 字段过滤），避免 100+ 卷把列表刷屏。
        volume: /(^|\/)[^/]*_分卷\//.test(rel),
        cat: override?.cat ?? inferred.cat,
        catReason: override?.cat ? '手动指定' : inferred.reason,
        group: /插件与工具归属|插件归属总表|00-通用与全局|^00-插件清单$/.test(baseName) ? '插件归属' : source.group,
        title,
        kind: override?.kind ?? decided.kind,
        type: override?.kind === 'core' && override?.type ? override.type : decided.type,
        reason: decided.reason,
        overridden: Boolean(override),
      })
    }
    if (source.dirOnly) {
      for (const file of await listRootMarkdown(path.join(base, source.path))) push(file)
      continue
    }
    for (const spec of source.paths ?? [source.path]) {
      const abs = path.join(base, spec)
      if (!existsSync(abs)) continue
      let info
      try { info = await stat(abs) } catch { continue }
      if (info.isDirectory()) {
        for (const file of await listMarkdown(abs, { only: source.only, depth: 0 })) push(file)
      } else if (info.isFile()) {
        push(abs)
      }
    }
  }

  // 字数 + 是否被路由：给列表和画布标状态圈用
  const routeDocTexts = []
  for (const doc of items.filter((item) => (item.group ?? '') === '路由（第二跳）')) {
    try { routeDocTexts.push(await readFile(path.join(roots[doc.rootKey], doc.rel), 'utf8')) } catch { /* 读不到就算了 */ }
  }
  const agentsRoutes = await parseRoutes(roots)
  const registry = await readValves(roots)
  const texts = new Map()
  for (const item of items) {
    let chars = 0
    let body = ''
    try {
      body = await readFile(path.join(roots[item.rootKey], item.rel), 'utf8')
      chars = body.length
      texts.set(item.id, body)
    } catch { chars = 0 }
    item.chars = chars
    item.bytes = Buffer.byteLength(body, 'utf8')
    let routed = agentsRoutes.some((route) => route.targets.some((target) => target.replace(/\\/g, '/').includes(item.title)))
    if (!routed) routed = routeDocTexts.some((routeBody) => routeBody.includes(item.title))
    if (!routed) routed = registry.some((valve) => (valve.entries ?? []).some((entry) => String(entry).includes(item.title)))
    item.routed = routed
  }
  // 被别的文件正文点名也算「用得上」（不然一堆经验文档会被误标灰圈）
  for (const item of items) {
    if (item.routed || item.title.length < 4) continue
    for (const [otherId, body] of texts) {
      if (otherId === item.id) continue
      if (body.includes(item.title)) { item.routed = true; break }
    }
  }
  // 硬上限（100% 会出问题 → 红圈）：
  //   AGENTS.md 超 agent-instructions 的 maxBytes → 尾部被截掉；SKILL.md 的 description 超 500 字 → 被截断
  const skillDescOf = (body) => {
    const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!front) return ''
    const line = front[1].split(/\r?\n/).find((row) => /^description\s*:/.test(row))
    if (!line) return ''
    return line.replace(/^description\s*:\s*/, '').replace(/^['"]|['"]$/g, '').trim()
  }
  for (const item of items) {
    const isAgents = item.title === 'AGENTS'
    const isSkill = (item.rel ?? '').endsWith('SKILL.md')
    let hard = ''
    if (isAgents && item.bytes > HARD_AGENTS_BYTES) {
      hard = 'AGENTS.md ' + item.bytes + ' 字节，超过 agent-instructions 上限 ' + HARD_AGENTS_BYTES + ' 字节，尾部会被截掉（每轮读到的是残缺版）'
    } else if (isSkill) {
      const desc = skillDescOf(texts.get(item.id) ?? '')
      if (desc.length > HARD_SKILL_DESC) {
        hard = 'SKILL.md 的 description ' + desc.length + ' 字，超过 ' + HARD_SKILL_DESC + ' 字，技能列表里会被截断'
      }
    }
    item.hard = hard
    if (item.volume) item.sizeStat = 'ok'          // 卷只在主文件页里打开，不参与四色状态
    else if (hard) item.sizeStat = 'hard'
    else if (item.chars > HEAVY_CHARS) item.sizeStat = 'heavy'
    else if (!item.routed) item.sizeStat = 'unused'
    else item.sizeStat = 'ok'
  }

  // 插件实体：从「插件归属」文档里抽，画布上挂成文档的下级（同一个插件可被多份文档列出）
  const pluginNodes = []
  const seenPlugins = new Map()
  for (const item of items) {
    if ((item.group ?? '') !== '插件归属') continue
    let body = ''
    try { body = await readFile(path.join(roots[item.rootKey], item.rel), 'utf8') } catch { continue }
    for (const plugin of parsePluginRows(body)) {
      pluginNodes.push({ id: 'plugin|' + plugin.id, title: plugin.id, desc: plugin.desc, fromDoc: item.id, cat: item.cat })
    }
  }

  const valves = (await readValves(roots)).map((valve) => ({
    id: `valve|${valve.id}`,
    valveId: valve.id,
    title: valve.id,
    script: valve.script,
    entries: valve.entries ?? [],
    coverage: valve.coverage ?? '',
    cat: 'general',
    group: '阀门清单',
    kind: 'core',
    type: '阀门',
    reason: '阀门：能用一条命令判对错的硬检查',
  }))

  const all = [...items, ...valves]
  const counts = {}
  const refCounts = {}
  for (const category of CATEGORIES) {
    counts[category.id] = all.filter((item) => item.cat === category.id && item.kind === 'core' && !item.volume).length
    refCounts[category.id] = all.filter((item) => item.cat === category.id && item.kind === 'ref' && !item.volume).length
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    roots: { ...roots },
    categories: CATEGORIES,
    items,
    valves,
    plugins: pluginNodes,
    heavyChars: HEAVY_CHARS,
    counts,
    refCounts,
  }
  cache.payload = payload
  cache.at = now
  return payload
}

async function readValves(roots) {
  const file = path.join(roots.work || '', 'tools', 'valve-registry.json')
  if (!roots.work || !existsSync(file)) return []
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(data.valves) ? data.valves : []
  } catch { return [] }
}

/* ── 关联：路由 / 阀门 / 引用 ─────────────────────────────── */

async function parseRoutes(roots) {
  const file = path.join(roots.dsh || '', 'AGENTS.md')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  const routes = []
  let inTable = false
  let lineNo = 0
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1
    if (/^\|/.test(line.trim())) {
      if (/这件事一出现/.test(line)) { inTable = true; continue }
      if (!inTable) continue
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      if (cells.length < 2) continue
      if (/^:?-{2,}/.test(cells[0] ?? '')) continue
      const trigger = cells[0].replace(/\*\*/g, '').replace(/`/g, '').trim()
      const targetCell = cells[1].trim()
      const tokens = [...targetCell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim())
      routes.push({ trigger, targets: tokens.filter(isDocToken), label: targetCell.replace(/`/g, '').replace(/——.*$/, '').trim(), line: lineNo })
      continue
    }
    if (inTable && line.trim() === '') inTable = false
  }
  return routes
}

function relMatches(route, item) {
  return route.targets.some((target) => {
    const norm = target.replace(/\\/g, '/')
    return norm.includes(item.title) || norm.includes(item.rel) || norm.includes(item.rel.replace(/\.md$/i, ''))
  })
}

async function buildLinks(roots, libraryDir, targetId) {
  const payload = await scanIndex(roots, libraryDir)
  const all = [...payload.items, ...payload.valves]
  const item = all.find((candidate) => candidate.id === targetId)
  const routes = await parseRoutes(roots)
  const valves = await readValves(roots)
  const links = { routesIn: [], valves: [], refs: [] }
  if (!item) return links

  if (!targetId.startsWith('valve|')) {
    for (const route of routes) if (relMatches(route, item)) links.routesIn.push({ trigger: route.trigger, label: route.label, line: route.line })
    for (const valve of valves) {
      const entries = valve.entries ?? []
      if (entries.some((entry) => entry.includes(item.title))) {
        links.valves.push({ id: valve.id, script: valve.script, coverage: valve.coverage, matched: entries.filter((entry) => entry.includes(item.title)) })
      }
    }
    if (item.rel.endsWith('.md')) {
      try {
        const text = await readFile(path.join(roots[item.rootKey], item.rel), 'utf8')
        for (const needle of all) {
          if (needle.id === item.id || needle.title.length < 4) continue
          if (text.includes(needle.title)) links.refs.push({ id: needle.id, title: needle.title, cat: needle.cat, kind: needle.kind })
          if (links.refs.length >= 40) break
        }
      } catch { /* 读不到就当没有引用 */ }
    }
  } else {
    const valveId = targetId.slice('valve|'.length)
    const valve = valves.find((candidate) => candidate.id === valveId)
    if (valve) {
      for (const entry of valve.entries ?? []) {
        const hit = payload.items.find((candidate) => entry.includes(candidate.title))
        if (hit) links.refs.push({ id: hit.id, title: hit.title, cat: hit.cat, kind: hit.kind })
      }
      const routeHits = routes.filter((route) => route.targets.some((target) => /AGENTS|开工索引/.test(target)))
      if (routeHits.length) links.routesIn.push({ trigger: '开工索引（阀门体检）', label: 'AGENTS.md', line: routeHits[0].line })
    }
  }
  return links
}

/* ── 开工索引表（路由行）的结构化编辑 ─────────────────────── */

const AGENTS_REL = 'AGENTS.md'

function locateRouteTable(lines) {
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/这件事一出现/.test(lines[index])) { start = index; break }
  }
  if (start < 0) return null
  let separator = start + 1
  while (separator < lines.length && !/^\|/.test(lines[separator].trim())) separator += 1
  if (separator >= lines.length) return null
  let end = separator + 1
  while (end < lines.length && /^\|/.test(lines[end].trim())) end += 1
  return { start, separator, end }
}

function parseRouteRows(lines, table) {
  const rows = []
  for (let index = table.separator + 1; index < table.end; index += 1) {
    const cells = lines[index].split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    const trigger = cells[0].replace(/\*\*/g, '').replace(/`/g, '').trim()
    const cell = cells[1].trim()
    const tokens = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim())
    const targets = tokens.filter(Boolean)
    const docs = tokens.filter(isDocToken)
    const label = cell.replace(/\*\*/g, '').replace(/`/g, '').replace(/——.*$/, '').trim()
    rows.push({ index: index - table.separator - 1, line: index + 1, trigger, cell, targets, docs, label })
  }
  return rows
}

function formatRouteRow(trigger, cellText) {
  return `| **${trigger.replace(/\|/g, '')}** | ${cellText.replace(/\|/g, '')} |`
}

async function readRouteTable(roots) {
  const file = path.join(roots.dsh || '', AGENTS_REL)
  if (!existsSync(file)) return { ok: false, error: 'agents-not-found' }
  const text = await readFile(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const table = locateRouteTable(lines)
  if (!table) return { ok: false, error: 'table-not-found' }
  return { ok: true, file, text, eol, lines, table, rows: parseRouteRows(lines, table) }
}

function applyRouteOp(source, body) {
  const table = source.table
  const rows = source.rows.slice()
  const op = String(body.op ?? '')
  const trigger = String(body.trigger ?? '').trim()
  const cellText = typeof body.cell === 'string' && body.cell.trim()
    ? body.cell.trim()
    : (Array.isArray(body.targets) ? body.targets.map((target) => '`' + String(target).trim() + '`').join('、') : '')
  if (op !== 'delete') {
    if (!trigger) throw new Error('触发语句不能为空')
    if (!cellText) throw new Error('目标文件不能为空')
  }
  if (op === 'add') rows.push({ trigger, cell: cellText, targets: [], docs: [], label: trigger })
  else if (op === 'update') {
    const index = Number(body.index)
    if (!(index >= 0 && index < rows.length)) throw new Error('要改的行不存在')
    rows[index] = { ...rows[index], trigger, cell: cellText }
  } else if (op === 'delete') {
    const index = Number(body.index)
    if (!(index >= 0 && index < rows.length)) throw new Error('要删的行不存在')
    rows.splice(index, 1)
  } else if (op === 'move') {
    const from = Number(body.index)
    const to = Number(body.to)
    if (!(from >= 0 && from < rows.length)) throw new Error('要移的行不存在')
    if (!(to >= 0 && to <= rows.length)) throw new Error('目标位置不对')
    const [row] = rows.splice(from, 1)
    rows.splice(to > from ? to - 1 : to, 0, row)
  } else throw new Error('不认识的操作：' + op)

  const nextLines = [
    ...source.lines.slice(0, table.separator + 1),
    ...rows.map((row) => formatRouteRow(row.trigger, row.cell)),
    ...source.lines.slice(table.end),
  ]
  return { nextText: nextLines.join(source.eol), rows }
}

function tableDiff(before, after) {
  const max = Math.max(before.length, after.length)
  const out = []
  for (let index = 0; index < max; index += 1) {
    if (before[index] !== after[index]) {
      out.push({ kind: 'before', no: index + 1, text: before[index] ?? '' })
      out.push({ kind: 'after', no: index + 1, text: after[index] ?? '' })
    }
  }
  return out
}

/* ── 画布：节点 + 连线 + 布局 ─────────────────────────────── */

function layoutFile(libraryDir) { return path.join(libraryDir, '画布布局.json') }

async function readLayout(libraryDir) {
  const file = layoutFile(libraryDir)
  if (!existsSync(file)) return {}
  try { return JSON.parse(await readFile(file, 'utf8')) ?? {} } catch { return {} }
}

function targetBasename(target) {
  const norm = String(target).replace(/\$PKG[\\/]/i, '').replace(/\$WORK[\\/]/i, '').replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? norm
  return last.replace(/\.(md|mjs|cjs|js|ps1|cmd|json)$/i, '')
}

function matchTarget(items, target) {
  const base = targetBasename(target)
  const norm = String(target).replace(/\\/g, '/')
  const exact = items.find((item) => item.title === base)
  if (exact) return exact
  const byRel = items.find((item) => norm.includes(item.rel.replace(/\\/g, '/')) || norm.includes(item.title))
  return byRel ?? null
}

async function buildCanvas(roots, libraryDir) {
  const table = await readRouteTable(roots)
  const payload = await scanIndex(roots, libraryDir)
  const nodes = new Map()
  const edges = []
  const rootId = encodeId('dsh', AGENTS_REL)

  const addNode = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { x: 0, y: 0, ...node })
    return nodes.get(node.id)
  }

  // 中心：AGENTS.md
  addNode({ id: rootId, label: 'AGENTS.md', sub: '开工索引', kind: 'root', cat: 'general' })

  // 全部入库文件都做节点——文件列表里点哪条，画布都能以它为中心
  for (const item of payload.items) {
    addNode({ id: item.id, label: item.title, sub: item.type, kind: 'file', cat: item.cat, rel: item.rel, itemKind: item.kind, chars: item.chars, sizeStat: item.sizeStat, routed: item.routed, hard: item.hard, bytes: item.bytes })
  }

  // 路由线：AGENTS.md → 目标（库里没有这条就画成虚线「未入库」节点）
  ;(table.ok ? table.rows : []).forEach((row, rowIndex) => {
    row.docs.forEach((target, targetIndex) => {
      const hit = matchTarget(payload.items, target)
      const node = hit
        ? addNode({ id: hit.id, label: hit.title, sub: hit.type, kind: 'file', cat: hit.cat, rel: hit.rel, itemKind: hit.kind })
        : addNode({ id: 'target|' + targetBasename(target), label: targetBasename(target), sub: '未入库', kind: 'ghost', cat: 'general' })
      edges.push({ id: 'route|' + rowIndex + '|' + targetIndex, from: rootId, to: node.id, kind: 'route', label: row.trigger, rowIndex, target })
    })
  })

  // 分类节点：AGENTS.md → 五类 → 文件
  for (const category of CATEGORIES) {
    const catNode = addNode({ id: 'cat|' + category.id, label: category.label, sub: '分类', kind: 'cat', cat: category.id })
    edges.push({ id: 'cat|root|' + category.id, from: rootId, to: catNode.id, kind: 'cat' })
    for (const item of payload.items) {
      if (item.cat !== category.id) continue
      if (item.id === rootId) continue
      edges.push({ id: 'cat|' + category.id + '|' + item.id, from: catNode.id, to: item.id, kind: 'cat' })
    }
  }

  // 阀门节点 + 阀门线
  for (const valve of payload.valves) {
    addNode({ id: valve.id, label: valve.valveId, sub: '阀门', kind: 'valve', cat: 'general' })
    for (const entry of valve.entries ?? []) {
      const hit = payload.items.find((item) => entry.includes(item.title))
      if (hit) {
        edges.push({ id: 'valve|' + valve.valveId + '|' + hit.id, from: hit.id, to: valve.id, kind: 'valve', label: valve.valveId })
        continue
      }
      const token = (String(entry).match(/[A-Za-z0-9_\-.\\/]+\.(mjs|js|cjs|ps1|cmd|md|json)/) ?? [String(entry).slice(0, 18)])[0]
      const ghost = addNode({ id: 'valve-target|' + valve.valveId + '|' + token, label: token, sub: '阀门入口·未入库', kind: 'ghost', cat: 'general' })
      edges.push({ id: 'valve|' + valve.valveId + '|' + token, from: ghost.id, to: valve.id, kind: 'valve', label: valve.valveId })
    }
  }

  // 插件节点：插件归属文档 → 它列出的插件（kind=plugin），点开能看到这个插件干什么
  for (const plugin of payload.plugins ?? []) {
    const node = addNode({ id: plugin.id, label: plugin.title, sub: '插件', kind: 'plugin', cat: plugin.cat, desc: plugin.desc, fromDoc: plugin.fromDoc })
    // 同一个插件可能被多份文档列出：留更完整的那句说明
    if (plugin.desc && (!node.desc || plugin.desc.length > node.desc.length)) node.desc = plugin.desc
    node.fromDoc = node.fromDoc ?? plugin.fromDoc
    edges.push({ id: 'plugin|' + plugin.fromDoc + '|' + plugin.title, from: plugin.fromDoc, to: plugin.id, kind: 'plugin', label: plugin.title })
  }

  // 引用线（规则层文件正文里点名了另一份文件；只给规则层算）
  const coreItems = payload.items.filter((item) => item.kind === 'core')
  for (const source of coreItems) {
    let body = ''
    try { body = await readFile(path.join(roots[source.rootKey], source.rel), 'utf8') } catch { continue }
    let count = 0
    for (const target of coreItems) {
      if (target.id === source.id || target.title.length < 4) continue
      if (!body.includes(target.title)) continue
      edges.push({ id: 'ref|' + source.id + '|' + target.id, from: source.id, to: target.id, kind: 'ref', label: target.title })
      count += 1
      if (count >= 12) break
    }
  }

  return {
    ok: true,
    nodes: [...nodes.values()],
    edges,
    rows: table.ok ? table.rows : [],
    warning: table.ok ? '' : 'AGENTS.md 里没找到「开工索引」表（表头应为「| 这件事一出现，就去读 |」），所以画布上没有路由线；文件与分类照常显示',
    total: payload.items.length,
    generatedAt: new Date().toISOString(),
  }
}

/* ── 备份与历史 ───────────────────────────────────────────── */

let backupSeq = 0

async function backupFile(libraryDir, rootKey, relPath, absPath) {
  backupSeq += 1
  const dir = path.join(libraryDir, 'history', `${stamp()}-${String(backupSeq).padStart(3, '0')}`)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${rootKey}__${relPath.split('/').join('__')}`)
  await copyFile(absPath, target)
  return target
}

async function listHistory(libraryDir, rootKey, relPath) {
  const root = path.join(libraryDir, 'history')
  if (!existsSync(root)) return []
  let dirs = []
  try { dirs = await readdir(root) } catch { return [] }
  dirs.sort().reverse()
  const out = []
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${rootKey}__${relPath.split('/').join('__')}`)
    if (existsSync(candidate)) out.push({ at: dir, file: candidate })
    if (out.length >= 8) break
  }
  return out
}

/* ── 插件主体 ─────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const dshRoot = path.join(os.homedir(), '.dsh')
  const libraryDir = config.libraryDir || path.join(dshRoot, '知识库')
  const pathTable = readPathTable(dshRoot)
  const custom = readLibraryConfigSync(libraryDir)

  // 优先：调用方 config → 知识库.json → 本机路径.md → 内置默认
  const roots = {
    dsh: config.dshRoot || custom.roots?.dsh || pathTable.dsh || dshRoot,
    pkg: config.pkgRoot || custom.roots?.pkg || pathTable.pkg || (pathTable.important ? path.join(pathTable.important, 'deepseek') : ''),
    work: config.workspaceRoot || custom.roots?.work || pathTable.work || '',
    // 配置里额外的项目根（多项目文件夹）
    ...Object.fromEntries(Object.entries(custom.roots ?? {}).filter(([key]) => !['dsh', 'pkg', 'work'].includes(key))),
  }
  if (custom.sources?.length) SOURCES = custom.sources

  // 装到别人机器上最常见的情况：根解析不到 → 说明清楚，别让人对着空列表
  const warnings = []
  if (!roots.pkg) warnings.push('没有解析到「同步盘知识包」（pkg 根为空）：PKG 下的规则/经验/路由都扫不到，可在 知识库.json 里配 roots.pkg')
  if (!roots.work) warnings.push('没有解析到「工作区」（work 根为空）：各 Agent 目录扫不到，可在 知识库.json 里配 roots.work')
  if (roots.work && !existsSync(roots.work)) warnings.push('工作区路径不存在：' + roots.work)
  if (roots.pkg && !existsSync(roots.pkg)) warnings.push('同步盘知识包路径不存在：' + roots.pkg)
  state.warnings = warnings

  loadDomainConfig(libraryDir).catch(() => {})

  ctx.inject(['webServer'], (webCtx) => {
    const register = (route) => webCtx.webServer.register(route)

    register({
      kind: 'exact',
      path: `${ROUTE}/status`,
      handler: (req, res) => json(res, 200, {
        ok: true, name, version: VERSION, roots, libraryDir,
        configFile: path.join(libraryDir, '知识库.json'),
        categoryFile: path.join(libraryDir, '分类.json'),
        sources: SOURCES.length,
        guideFile: GUIDE_FILE,
        guideRoute: ROUTE + '/guide',
        warnings: state.warnings ?? [],
      }),
    })

    // 给 AI 读的接入指南：别的 AI 用 curl -f 取全文，照着改自己那台机器的配置
    register({
      kind: 'exact',
      path: `${ROUTE}/guide`,
      handler: async (req, res) => {
        try {
          if (!existsSync(GUIDE_FILE)) return json(res, 404, { ok: false, error: 'guide-missing', path: GUIDE_FILE })
          const text = await readFile(GUIDE_FILE, 'utf8')
          const url = new URL(req.url, 'http://127.0.0.1')
          if (url.searchParams.get('format') === 'json') {
            return json(res, 200, {
              ok: true, version: VERSION, path: GUIDE_FILE, chars: text.length,
              sectionCount: (text.match(/^## /gm) ?? []).length,
              status: { roots, libraryDir, configFile: path.join(libraryDir, '知识库.json'), warnings: state.warnings ?? [] },
              guide: text,
            })
          }
          res.writeHead?.(200, { 'content-type': 'text/markdown; charset=utf-8' })
          res.end(text)
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    // 自动发现知识目录：多项目文件夹的人不用一条条手写 sources
    // 自动发现知识目录：多项目文件夹的人不用一条条手写 sources
    register({
      kind: 'exact',
      path: `${ROUTE}/discover`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const asked = url.searchParams.get('base')
          const bases = asked ? [asked] : ['work', 'pkg'].map((key) => roots[key]).filter(Boolean).concat(['Documents', 'Desktop', 'Projects', 'workspace', 'code', 'dev'].map((name) => path.join(os.homedir(), name)).filter((dir) => existsSync(dir)))
          const candidates = discoveredFor(roots, asked ? [asked] : undefined)
          json(res, 200, { ok: true, bases, candidates })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
    // 把发现的目录并入 知识库.json 的 sources（去重；写前备份）
    register({
      kind: 'exact',
      path: `${ROUTE}/sources`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          let incoming = Array.isArray(body.sources) ? body.sources : []
          const configFile = path.join(libraryDir, '知识库.json')
          let current = { roots: { ...roots }, sources: SOURCES.map((row) => ({ ...row })) }
          if (existsSync(configFile)) {
            try { current = { ...current, ...JSON.parse(readFileSync(configFile, 'utf8')) } } catch { /* 坏文件就按内存里的写 */ }
          }
          const before = Array.isArray(current.sources) ? current.sources : []
          const keyOf = (row) => [row.cat, row.root, row.path ?? '', Array.isArray(row.paths) ? row.paths.join('|') : ''].join('::')
          const have = new Set(before.map(keyOf))
          let added = 0
          for (const row of incoming) {
            if (!row || typeof row !== 'object' || typeof row.path !== 'string') continue
            if (have.has(keyOf(row))) continue
            before.push({ cat: String(row.cat ?? 'general'), group: String(row.group ?? '其他'), root: String(row.root ?? 'work'), path: row.path, dir: row.dir !== false })
            have.add(keyOf(row))
            added += 1
          }
          current.roots = current.roots ?? { ...roots }
          current.sources = before
          await mkdir(libraryDir, { recursive: true })
          if (existsSync(configFile)) await copyFile(configFile, configFile + '.bak-' + Date.now())
          await writeFile(configFile, JSON.stringify(current, null, 2) + '\n', 'utf8')
          SOURCES = before.map((row) => ({ ...row, cat: String(row.cat ?? 'general'), group: String(row.group ?? '其他') }))
          cache.payload = null
          json(res, 200, { ok: true, added, total: before.length, file: configFile })
        } catch (error) { json(res, 400, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
    register({
      kind: 'exact',
      path: `${ROUTE}/index`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const payload = await scanIndex(roots, libraryDir, { force: url.searchParams.get('force') === '1' })
          json(res, 200, { ...payload, warnings: state.warnings ?? [] })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/doc`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          if (id.startsWith('valve|')) {
            const valve = (await readValves(roots)).find((candidate) => candidate.id === id.slice('valve|'.length))
            if (!valve) return json(res, 404, { ok: false, error: 'valve-not-found' })
            return json(res, 200, { ok: true, id, kind: 'valve', content: JSON.stringify(valve, null, 2), readonly: true, path: path.join(roots.work, 'tools', 'valve-registry.json') })
          }
          const { rootKey, relPath } = decodeId(id)
          const abs = safeJoin(resolveRoot(roots, rootKey), relPath)
          if (!existsSync(abs)) return json(res, 404, { ok: false, error: 'not-found', path: abs })
          json(res, 200, { ok: true, id, kind: 'file', content: await readFile(abs, 'utf8'), path: abs, relPath, rootKey, readonly: false })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/save`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          if (String(body.id ?? '').startsWith('valve|')) return json(res, 400, { ok: false, error: 'valve-readonly' })
          const { rootKey, relPath } = decodeId(body.id)
          const abs = safeJoin(resolveRoot(roots, rootKey), relPath)
          if (!existsSync(abs)) return json(res, 404, { ok: false, error: 'not-found' })
          const backup = await backupFile(libraryDir, rootKey, relPath, abs)
          await writeFile(abs, String(body.content ?? ''), 'utf8')
          cache.payload = null
          json(res, 200, { ok: true, id: body.id, path: abs, backup })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/override`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const id = String(body.id ?? '')
          if (!id) return json(res, 400, { ok: false, error: 'bad-id' })
          const overrides = await readOverrides(libraryDir)
          const CAT_IDS = new Set(CATEGORIES.map((item) => item.id))
          if (body.kind === 'reset' && !body.cat) delete overrides[id]
          else {
            const current = { ...(overrides[id] ?? {}) }
            if (body.kind === 'reset') delete current.kind
            else if (body.kind !== undefined) {
              current.kind = body.kind === 'core' ? 'core' : 'ref'
              if (body.type) current.type = String(body.type)
              else delete current.type
            }
            if (body.cat !== undefined) {
              if (body.cat === 'auto') delete current.cat
              else if (CAT_IDS.has(String(body.cat))) current.cat = String(body.cat)
              else return json(res, 400, { ok: false, error: 'bad-cat' })
            }
            if (Object.keys(current).length) overrides[id] = current
            else delete overrides[id]
          }
          await writeOverrides(libraryDir, overrides)
          cache.payload = null
          json(res, 200, { ok: true, id, kind: overrides[id]?.kind ?? 'auto', cat: overrides[id]?.cat ?? 'auto' })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/canvas`,
      handler: async (req, res) => {
        try { json(res, 200, await buildCanvas(roots, libraryDir)) } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/canvas/layout`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const positions = body.positions ?? {}
          if (body.reset === true) {
            await mkdir(libraryDir, { recursive: true })
            await writeFile(layoutFile(libraryDir), '{}', 'utf8')
            return json(res, 200, { ok: true, reset: true, changed: 0 })
          }
          const layout = await readLayout(libraryDir)
          let changed = 0
          for (const [id, position] of Object.entries(positions)) {
            if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') continue
            layout[id] = { x: Math.round(position.x), y: Math.round(position.y) }
            changed += 1
          }
          await mkdir(libraryDir, { recursive: true })
          await writeFile(layoutFile(libraryDir), JSON.stringify(layout, null, 2), 'utf8')
          json(res, 200, { ok: true, changed })
        } catch (error) { json(res, 400, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/routes`,
      handler: async (req, res) => {
        try {
          const table = await readRouteTable(roots)
          if (!table.ok) {
            return json(res, 200, {
              ok: true, file: path.join(roots.dsh || '', AGENTS_REL), rows: [], count: 0,
              warning: 'AGENTS.md 里没找到「开工索引」表（表头应为「| 这件事一出现，就去读 |」）；这台机器上还没有两跳路由，或用了别的格式',
            })
          }
          json(res, 200, { ok: true, file: table.file, rows: table.rows, count: table.rows.length })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/routes/preview`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const table = await readRouteTable(roots)
          if (!table.ok) return json(res, 404, { ok: false, error: table.error })
          const result = applyRouteOp(table, body)
          const beforeLines = table.lines.slice(table.table.separator + 1, table.table.end)
          const afterLines = result.nextText.split(table.eol).slice(table.table.separator + 1).filter((line) => /^\|/.test(line.trim()))
          json(res, 200, {
            ok: true,
            diff: tableDiff(beforeLines, afterLines),
            rows: result.rows,
            changed: result.nextText !== table.text,
          })
        } catch (error) { json(res, 400, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/routes/publish`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const table = await readRouteTable(roots)
          if (!table.ok) return json(res, 404, { ok: false, error: table.error })
          const result = applyRouteOp(table, body)
          if (result.nextText === table.text) return json(res, 200, { ok: true, changed: false, rows: result.rows })
          const backup = await backupFile(libraryDir, 'dsh', AGENTS_REL, table.file)
          await writeFile(table.file, result.nextText, 'utf8')
          // 写完立刻回读校验：表能重新解析、行数一致、表外的正文一个字节都没变
          const verified = await readRouteTable(roots)
          const before = { head: table.lines.slice(0, table.table.separator + 1), tail: table.lines.slice(table.table.end) }
          const after = verified.ok ? { head: verified.lines.slice(0, verified.table.separator + 1), tail: verified.lines.slice(verified.table.end) } : null
          const okCount = verified.ok && verified.rows.length === result.rows.length
          const keptBody = Boolean(after) && JSON.stringify(before) === JSON.stringify(after)
          if (!okCount || !keptBody) {
            await copyFile(backup, table.file)
            cache.payload = null
            return json(res, 500, { ok: false, error: '写完校验不过，已自动退回', rows: table.rows, okCount, keptBody })
          }
          cache.payload = null
          json(res, 200, { ok: true, changed: true, backup, rows: verified.rows, count: verified.rows.length })
        } catch (error) { json(res, 400, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/links`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          json(res, 200, { ok: true, id, ...(await buildLinks(roots, libraryDir, id)) })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/history`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          if (id.startsWith('valve|')) return json(res, 200, { ok: true, items: [] })
          const { rootKey, relPath } = decodeId(id)
          json(res, 200, { ok: true, id, items: await listHistory(libraryDir, rootKey, relPath) })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/restore`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const { rootKey, relPath } = decodeId(body.id)
          const abs = safeJoin(resolveRoot(roots, rootKey), relPath)
          if (!existsSync(abs)) return json(res, 404, { ok: false, error: 'not-found' })
          const wanted = String(body.backup ?? '')
          if (!wanted || wanted.includes('..') || wanted.includes('/') || wanted.includes('\\')) return json(res, 400, { ok: false, error: 'bad-backup' })
          const source = path.join(libraryDir, 'history', wanted, `${rootKey}__${relPath.split('/').join('__')}`)
          if (!existsSync(source)) return json(res, 404, { ok: false, error: 'backup-not-found' })
          const keep = await backupFile(libraryDir, rootKey, relPath, abs)
          await copyFile(source, abs)
          cache.payload = null
          json(res, 200, { ok: true, id: body.id, from: source, alsoBackedUp: keep })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })

    register({
      kind: 'exact',
      path: `${ROUTE}/graph`,
      handler: async (req, res) => {
        try {
          const payload = await scanIndex(roots, libraryDir)
          const routes = await parseRoutes(roots)
          const nodes = payload.items.filter((item) => !item.volume).map((item) => ({ id: item.id, label: item.title, cat: item.cat, type: item.type, group: item.group, kind: item.kind }))
          for (const valve of payload.valves) nodes.push({ id: valve.id, label: valve.title, cat: 'general', type: '阀门', group: '阀门清单', kind: 'core' })
          const edges = []
          for (const route of routes) {
            for (const item of payload.items) {
              if (relMatches(route, item)) edges.push({ from: encodeId('dsh', AGENTS_REL), to: item.id, kind: 'route', label: route.trigger })
            }
          }
          for (const valve of payload.valves) {
            for (const item of payload.items) {
              if ((valve.entries ?? []).some((entry) => entry.includes(item.title))) edges.push({ from: valve.id, to: item.id, kind: 'valve', label: valve.valveId })
            }
          }
          json(res, 200, { ok: true, nodes, edges })
        } catch (error) { json(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
  })
}
