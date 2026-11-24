/**
 * 知识库 · 客户端
 *
 * 左侧栏一栏 + 主面板。数据全部走主机路由 `/plugins/dsh-knowledge-base/*`，
 * 面板只负责展示与编辑；正文永远是磁盘上那份原始文件。
 *
 * 收录口径：core（规则/流程/知识/经验/技能/索引/阀门）默认可见；
 * ref（原始简报/学习摘录/案例实测/报告/记录/项目交付）默认隐藏，可一键显示，也能一条条改判。
 */

window.__ModuleLoader__.load({
  id: 'dsh-knowledge-base',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/plugins/dsh-knowledge-base'
    const BUILD = '0.24.0'

// 客户端 Cordis ctx：apply 时存下来，面板里才拿得到 uiWorkspace 这类服务
let CORDIS = null

/**
 * 把绝对路径变成 DSH 输入框认得的 @ 引用。
 * 规则抄自 DSH 的 file-reference grammar：路径里只要有空白就必须写成 @"path"，
 * 没有空白写 @path（不会误判时才用短形式）。
 */
function mentionOfPath(absPath) {
  const value = String(absPath ?? '')
  if (!value) return ''
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(value)) return '@' + value
  return /\s/u.test(value) ? '@"' + value + '"' : '@' + value
}

/** 引用落到输入框时的整段草稿：先给引用，再留一行「我的要求：」让他直接接着写。 */
function buildReferencePrompt(absPath) {
  const mention = mentionOfPath(absPath)
  if (!mention) return ''
  return mention + '\n\n我的要求：'
}

const CAT_LABEL = { general: '通用', design: '设计 Agent', dynamic: '动态 Agent', assistant: '助手 Agent', finance: '金融 Agent' }

    function formatChars(value) {
      const chars = Number(value) || 0
      if (!chars) return ''
      if (chars >= 10000) return (chars / 10000).toFixed(1) + ' 万字'
      if (chars >= 1000) return (chars / 1000).toFixed(1) + ' 千字'
      return chars + ' 字'
    }

    function api(pathSuffix, options) {
      return fetch(`${ROUTE}${pathSuffix}`, options).then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
        return data
      })
    }

    function SidebarIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('path', { key: 'l', d: 'M4 5.5A2 2 0 0 1 6 3.5h5.5v17H6a2 2 0 0 0-2 2z' }),
        h('path', { key: 'r', d: 'M20 5.5a2 2 0 0 0-2-2h-5.5v17H18a2 2 0 0 1 2 2z' }),
        h('path', { key: 'c', d: 'M7.6 8.5h4.4M12 8.5h4.4', strokeWidth: 1.2 }),
      ])
    }

    const CSS = `
.kb-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
.kb-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}
.kb-title{font-weight:600;font-size:14px;margin-right:6px;}
.kb-tabs{display:flex;gap:4px;flex-wrap:wrap;}
.kb-tab{font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.kb-tab[data-on="1"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}
.kb-select{font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}
.kb-search{flex:0 1 200px;min-width:110px;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}
.kb-btn{font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.kb-btn[data-on="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600;}
.kb-btn:disabled{opacity:.5;cursor:default;}
.kb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}
.kb-body{display:flex;flex:1;min-height:0;}
.kb-list{width:340px;flex:0 0 340px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:6px 0 24px;}
.kb-group{padding:8px 12px 2px;font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);}
.kb-row{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;border-left:2px solid transparent;}
.kb-row:hover{background:var(--dsw-alias-bg-layer-2);}
.kb-row[data-on="1"]{background:var(--dsw-alias-bg-layer-2);border-left-color:var(--dsw-alias-brand-primary);}
.kb-row[data-ref="1"]{opacity:.62;}
.kb-row-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kb-ring{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-sizing:border-box;border:2px solid var(--dsw-alias-border-l2);}
.kb-ring[data-status="ok"]{border-color:#2f9e5f;}
.kb-ring[data-status="heavy"]{border-color:#e08b2d;}
.kb-ring[data-status="hard"]{border-color:#d13b30;border-width:3px;}
.kb-ring[data-status="unused"]{border-color:#9a9a9a;border-style:dashed;}

.kb-chars{font-size:10px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;white-space:nowrap;}
.kb-type{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:0 0 auto;}
.kb-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}
.kb-filebar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}
.kb-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;flex:1;min-width:120px;}
.kb-dirty{font-size:11px;color:var(--dsw-alias-brand-primary);}
.kb-editor{flex:1;min-height:0;display:flex;}
.kb-textarea{flex:1;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;padding:12px 16px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12.5px;line-height:1.65;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.kb-side{width:300px;flex:0 0 300px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l1);padding:10px 12px 24px;}
.kb-side h4{margin:12px 0 6px;font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);font-weight:600;}
.kb-link{display:block;width:100%;text-align:left;font:inherit;font-size:12px;padding:5px 8px;margin-bottom:4px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden;text-overflow:ellipsis;}
.kb-link:hover{border-color:var(--dsw-alias-brand-primary);}
.kb-muted{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;}
.kb-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);z-index:50;}
.kb-empty{padding:28px 20px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;}
.kb-routes{flex:1;min-height:0;overflow:auto;padding:12px 16px 32px;display:flex;flex-direction:column;gap:8px;}
.kb-routes-head{display:flex;flex-direction:column;gap:4px;margin-bottom:6px;}
.kb-route-row{display:flex;align-items:center;gap:8px;}
.kb-route-no{flex:0 0 26px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:right;}
.kb-route-trigger{flex:0 1 300px;min-width:140px;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}
.kb-route-targets{flex:1;min-width:180px;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);}
.kb-route-add{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px;}
.kb-diff{margin-top:14px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);max-height:40vh;overflow:auto;}
.kb-diff-line{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;}
.kb-diff-line[data-kind="before"]{color:#c4553b;}
.kb-diff-line[data-kind="after"]{color:#2f7d6f;}
.kb-canvas-wrap{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;}
.kb-focusbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.kb-focusbadge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}
.kb-focusname{font-size:13px;font-weight:600;}
.kb-crumb{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:12px;}
.kb-crumb-item{font:inherit;font-size:12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px 4px;border-radius:6px;}
.kb-crumb-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.kb-crumb-item:disabled{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default;}
.kb-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.kb-legend-swatch{display:inline-block;width:26px;height:10px;border-radius:5px;border:0;}
.kb-legend-swatch[data-kind="route"]{background:var(--dsw-alias-brand-primary);}
.kb-legend-swatch[data-kind="valve"]{background:repeating-linear-gradient(90deg,#c4553b 0 6px,transparent 6px 10px);}
.kb-legend-swatch[data-kind="cat"]{background:var(--dsw-alias-label-secondary);height:6px;opacity:.6;}
.kb-legend-swatch[data-kind="ref"]{background:repeating-linear-gradient(90deg,#5a8fa8 0 3px,transparent 3px 7px);}
.kb-legend-swatch[data-kind="plugin"]{background:transparent;border:2px solid var(--dsw-alias-label-secondary);height:8px;}
.kb-legend-swatch[data-kind="status"]{background:linear-gradient(90deg,#2f9e5f 0 25%,#e08b2d 25% 50%,#d13b30 50% 75%,#9a9a9a 75% 100%);height:8px;}
.kb-canvas-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}
.kb-canvas{flex:1;min-height:0;position:relative;overflow:hidden;cursor:grab;background-image:radial-gradient(var(--dsw-alias-border-l1) 1px, transparent 1px);background-size:22px 22px;}
.kb-canvas:active{cursor:grabbing;}
.kb-canvas-inner{position:absolute;left:0;top:0;width:4000px;height:3000px;transform-origin:0 0;}
.kb-canvas-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;}
.kb-edge{fill:none;stroke-width:1.6;opacity:.55;pointer-events:stroke;cursor:pointer;}
.kb-edge[data-kind="route"]{stroke:var(--dsw-alias-brand-primary);}
.kb-edge[data-kind="valve"]{stroke:#c4553b;stroke-dasharray:5 4;}
.kb-edge[data-kind="cat"]{stroke:var(--dsw-alias-label-secondary);stroke-width:1.1;opacity:.45;}
.kb-edge[data-kind="ref"]{stroke:#5a8fa8;stroke-width:1.1;stroke-dasharray:2 4;opacity:.5;}
.kb-edge[data-on="1"]{stroke-width:2.6;opacity:1;}
.kb-edge-label{font-size:11px;fill:var(--dsw-alias-label-secondary);paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3px;pointer-events:none;}
.kb-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:grab;user-select:none;overflow:hidden;}
/* 类型只用线型/粗细区分，不新增颜色：颜色统一留给下面的「状态四色」 */
.kb-node[data-kind="root"]{border-width:3px;font-weight:600;}
.kb-node[data-kind="ghost"]{border-style:dotted;opacity:.65;}
.kb-node[data-kind="valve"]{border-style:dashed;border-width:2px;}
.kb-node[data-kind="cat"]{background:transparent;font-weight:600;border-style:dashed;}
.kb-node[data-kind="plugin"]{border-width:2px;}
.kb-node[data-status="ok"]{border-left:3px solid #2f9e5f;}
.kb-node[data-status="heavy"]{border-left:3px solid #e08b2d;}
.kb-node[data-status="hard"]{border-left:4px solid #d13b30;}
.kb-node[data-status="unused"]{border-left:3px solid #9a9a9a;border-left-style:dotted;}
.kb-node[data-on="1"]{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary);}
.kb-node-label{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kb-node-sub{font-size:10px;color:var(--dsw-alias-label-secondary);}
.kb-canvas-side{position:absolute;right:12px;top:52px;width:270px;max-height:calc(100% - 70px);overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column;gap:6px;}
.kb-canvas-side h4{margin:4px 0 2px;font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);}
.kb-inline-textarea{width:100%;min-height:180px;max-height:42vh;box-sizing:border-box;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}
.kb-input{font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}
.kb-menu-backdrop{position:fixed;inset:0;z-index:60;}
.kb-menu{position:fixed;min-width:210px;max-width:240px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:2px;}
.kb-menu-title{padding:4px 8px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kb-menu-item{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 8px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left;}
.kb-menu-item:hover{background:var(--dsw-alias-bg-layer-1);}
.kb-menu-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);}
.kb-guidepanel{position:fixed;inset:8% 10%;z-index:50;display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 16px 48px rgba(0,0,0,.28);}
.kb-guidetext{flex:1;overflow:auto;margin:0;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;}
.kb-warnbar{position:fixed;left:50%;transform:translateX(-50%);bottom:52px;z-index:40;max-width:min(760px, 90%);padding:10px 14px;border-radius:10px;border:1px solid #e0a53a;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:3px;font-size:12px;}
.kb-diff-float{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:min(760px, 86%);z-index:20;}
`

    function StyleTag() { return h('style', { key: 'kb-style' }, CSS) }

    /* ── 画布：聚焦三级视图（上级 / 本文件 / 下级）────────── */

    const NODE_W = 200
    const NODE_H = 44
    const COL_GAP = 400
    const ROW_GAP = 62

    /* 聚焦子图：上级（最多 2 级）/ 本文件 / 下级（AGENTS.md 自身只展开 1 级）。
       抽成纯函数，便于自检断言，不依赖 React。 */
    function focusSubgraph(data, focusId) {
      if (!data) return null
      const nodeById = new Map(data.nodes.map((node) => [node.id, node]))
      const parentsOf = new Map()
      const childrenOf = new Map()
      for (const edge of data.edges) {
        if (edge.kind === 'ref' || edge.kind === 'route') continue
        if (!parentsOf.has(edge.to)) parentsOf.set(edge.to, [])
        parentsOf.get(edge.to).push(edge)
        if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, [])
        childrenOf.get(edge.from).push(edge)
      }
      const root = data.nodes.find((node) => node.kind === 'root')
      const focus = (focusId && nodeById.get(focusId)) || root
      if (!focus) return null

      const depth = new Map([[focus.id, 0]])
      const walkUp = (id, level) => {
        if (level > 2) return
        for (const edge of parentsOf.get(id) ?? []) {
          const nextLevel = -level
          if (depth.has(edge.from) && depth.get(edge.from) <= nextLevel) continue
          depth.set(edge.from, nextLevel)
          walkUp(edge.from, level + 1)
        }
      }
      const maxDown = focus.id === root?.id ? 1 : (focus.kind === 'cat' ? 1 : 3)
      const walkDown = (id, level) => {
        if (level > maxDown) return
        for (const edge of childrenOf.get(id) ?? []) {
          if (depth.has(edge.to) && depth.get(edge.to) >= level) continue
          depth.set(edge.to, level)
          walkDown(edge.to, level + 1)
        }
      }
      walkUp(focus.id, 1)
      walkDown(focus.id, 1)

      // 总览（中心是 AGENTS.md）：只放 AGENTS.md + 五个分类，点分类再看它下面的文件
      if (focus.id === root?.id) {
        const positioned = new Map()
        const cats = data.nodes.filter((node) => node.kind === 'cat').sort((left, right) => left.label.localeCompare(right.label, 'zh'))
        const rowsAll = Math.max(cats.length, 1)
        const rootY = 60 + (rowsAll - 1) * ROW_GAP / 2
        positioned.set(focus.id, { node: focus, x: 20, y: rootY })
        cats.forEach((node, index) => {
          positioned.set(node.id, { node, x: 20 + COL_GAP, y: 60 + index * ROW_GAP })
        })
        const edges = data.edges.filter((edge) => positioned.has(edge.from) && positioned.has(edge.to))
        return { focus, positioned, edges, nodeById, parentsOf, childrenOf, levels: [0, 1], grouped: true }
      }

      // 聚焦某个分类：上级 AGENTS.md、中间分类、下级按类型分列
      if (focus.kind === 'cat') {
        const TYPE_ORDER_LOCAL = ['规则', '流程', '技能', '索引', '知识', '经验', '证据', '摘录', '报告', '记录', '清单', '参考', '阀门']
        const positioned = new Map()
        const parents = (parentsOf.get(focus.id) ?? []).map((edge) => edge.from).filter((id) => nodeById.has(id))
        const files = [...positioned === null ? [] : []]
        void files
        const children = data.nodes
          .filter((node) => node.kind === 'file' && node.cat === focus.cat)
          .sort((left, right) => {
            const leftIndex = TYPE_ORDER_LOCAL.indexOf(left.sub ?? '')
            const rightIndex = TYPE_ORDER_LOCAL.indexOf(right.sub ?? '')
            return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) || left.label.localeCompare(right.label, 'zh')
          })
        const bucketOf = (sub) => {
          if (['规则', '流程', '技能', '阀门'].includes(sub)) return '规则·流程·技能'
          if (['知识', '经验'].includes(sub)) return '知识·经验'
          if (sub === '索引') return '索引'
          return '参考·证据·记录'
        }
        const groups = new Map()
        for (const node of children) {
          const key = bucketOf(node.sub ?? '')
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(node)
        }
        groups.forEach((list) => list.sort((left, right) => left.label.localeCompare(right.label, 'zh')))
        const columnsX = [20, 20 + COL_GAP, 20 + COL_GAP * 2]
        const tallest = Math.max(...[...groups.values()].map((list) => list.length), 1)
        positioned.set(focus.id, { node: focus, x: columnsX[1], y: 60 + ((tallest - 1) * ROW_GAP) / 2 })
        for (const parentId of parents) positioned.set(parentId, { node: nodeById.get(parentId), x: columnsX[0], y: 60 + ((tallest - 1) * ROW_GAP) / 2 })
        let typeIndex = 0
        for (const [, list] of groups) {
          const x = columnsX[2] + typeIndex * COL_GAP
          list.forEach((node, index) => positioned.set(node.id, { node, x, y: 60 + index * ROW_GAP }))
          typeIndex += 1
        }
        const edges = data.edges.filter((edge) => edge.kind !== 'ref' && positioned.has(edge.from) && positioned.has(edge.to))
        return { focus, positioned, edges, nodeById, parentsOf, childrenOf, levels: [-1, 0, 1], grouped: true }
      }

      const columns = new Map()
      for (const [id, level] of depth) {
        if (!nodeById.has(id)) continue
        if (!columns.has(level)) columns.set(level, [])
        columns.get(level).push(nodeById.get(id))
      }
      const positioned = new Map()
      const levels = [...columns.keys()].sort((a, b) => a - b)
      const tallest = Math.max(...levels.map((level) => columns.get(level).length), 1)
      for (const level of levels) {
        const list = columns.get(level).slice().sort((left, right) => left.label.localeCompare(right.label, 'zh'))
        const offset = ((tallest - list.length) * ROW_GAP) / 2
        list.forEach((node, index) => {
          positioned.set(node.id, { node, x: 460 + level * COL_GAP, y: 60 + offset + index * ROW_GAP })
        })
      }
      const edges = data.edges.filter((edge) => positioned.has(edge.from) && positioned.has(edge.to))
      return { focus, positioned, edges, nodeById, parentsOf, childrenOf, levels }
    }

    function CanvasView({ flash, reload, onOpenFile, focusId, onFocus, onFocusNode, onMenu, onReference }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [zoom, setZoom] = React.useState(1)
      const [pick, setPick] = React.useState(null)
      const [showLabels, setShowLabels] = React.useState(false)
      const [showRefLines, setShowRefLines] = React.useState(false)
      const [diff, setDiff] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState({ trigger: '', cell: '' })
      const [inline, setInline] = React.useState(null)
      const canvasRef = React.useRef(null)
      const dragRef = React.useRef(null)

      const load = React.useCallback(() => {
        api('/canvas').then((payload) => {
          setData(payload)
          setError('')
          void payload
        }).catch((err) => setError(String(err.message || err)))
      }, [])
      React.useEffect(() => { load() }, [load])

      const onWheel = (event) => {
        event.preventDefault()
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect) return
        const factor = event.deltaY > 0 ? 0.9 : 1.1
        const nextZoom = Math.min(2.2, Math.max(0.35, zoom * factor))
        const cursorX = event.clientX - rect.left
        const cursorY = event.clientY - rect.top
        setPan({
          x: cursorX - (cursorX - pan.x) * (nextZoom / zoom),
          y: cursorY - (cursorY - pan.y) * (nextZoom / zoom),
        })
        setZoom(nextZoom)
      }

      const startPan = (event) => {
        if (event.button !== 0) return
        dragRef.current = { startX: event.clientX, startY: event.clientY, origin: { x: pan.x, y: pan.y } }
      }
      const movePan = (event) => {
        const drag = dragRef.current
        if (!drag) return
        setPan({ x: drag.origin.x + (event.clientX - drag.startX), y: drag.origin.y + (event.clientY - drag.startY) })
      }
      const endPan = () => { dragRef.current = null }

      const graph = React.useMemo(() => focusSubgraph(data, focusId), [data, focusId])

      React.useEffect(() => {
        if (pick?.kind !== 'node' || !data) { setInline(null); return }
        const node = data.nodes.find((item) => item.id === pick.id)
        if (!node || node.kind !== 'file') { setInline(null); return }
        api('/doc?id=' + encodeURIComponent(node.id))
          .then((doc) => setInline({ id: node.id, saved: doc.content, content: doc.content, path: doc.path }))
          .catch(() => setInline(null))
      }, [pick, data])

      const saveInline = () => {
        if (!inline || inline.content === inline.saved) return
        setBusy('inline')
        api('/save', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: inline.id, content: inline.content }),
        }).then(() => {
          setInline({ ...inline, saved: inline.content })
          load(); reload(true)
          flash('已保存（改动前已备份，可在右侧历史备份退回）')
        }).catch((err) => flash('保存失败：' + err.message))
          .finally(() => setBusy(''))
      }

      React.useEffect(() => {
        if (!graph) return
        const rect = canvasRef.current?.getBoundingClientRect()
        if (!rect || !rect.width) return
        const list = [...graph.positioned.values()]
        if (!list.length) return
        const minX = Math.min(...list.map((entry) => entry.x))
        const maxX = Math.max(...list.map((entry) => entry.x)) + NODE_W
        const minY = Math.min(...list.map((entry) => entry.y))
        const maxY = Math.max(...list.map((entry) => entry.y)) + NODE_H
        const scale = Math.min(1.25, Math.max(0.4, Math.min((rect.width - 120) / (maxX - minX), (rect.height - 120) / (maxY - minY))))
        setZoom(scale)
        setPan({
          x: (rect.width - (maxX - minX) * scale) / 2 - minX * scale,
          y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale,
        })
      }, [graph])

      const preview = (body) => {
        setBusy('preview')
        api('/routes/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }).then((result) => { setDiff(result.diff); setPending(body) })
          .catch((err) => flash('预览失败：' + err.message))
          .finally(() => setBusy(''))
      }

      const publish = () => {
        if (!pending) return
        setBusy('publish')
        api('/routes/publish', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending),
        }).then(() => {
          setDiff(null); setPending(null); setPick(null); setForm({ trigger: '', cell: '' })
          load(); reload(true)
          flash('已发布（发布前已备份）；新会话开始生效')
        }).catch((err) => flash('发布失败：' + err.message))
          .finally(() => setBusy(''))
      }

      const edgePath = (edge) => {
        const from = graph?.positioned.get(edge.from)
        const to = graph?.positioned.get(edge.to)
        if (!from || !to) return null
        const x1 = from.x + NODE_W
        const y1 = from.y + NODE_H / 2
        const x2 = to.x
        const y2 = to.y + NODE_H / 2
        const bend = Math.max(50, Math.abs(x2 - x1) * 0.45)
        return { d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } }
      }

      if (error) return h('div', { className: 'kb-empty' }, '画布读不出来：' + error)
      if (!data || !graph) return h('div', { className: 'kb-empty' }, '画布加载中…')

      const pickedEdge = pick?.kind === 'edge' ? data.edges.find((edge) => edge.id === pick.id) : null
      const pickedNode = pick?.kind === 'node' ? graph.nodeById.get(pick.id) : null
      const routeInto = pickedNode ? (graph.parentsOf.get(pickedNode.id) ?? []).find((edge) => edge.kind === 'route') : null
      const rootNode = data.nodes.find((node) => node.kind === 'root')

      return h('div', { className: 'kb-canvas-wrap' }, [
        h('div', { key: 'bar', className: 'kb-canvas-bar' }, [
          h('div', { key: 'legend', className: 'kb-legend' }, [
            h('span', { key: 'r1', className: 'kb-legend-swatch', 'data-kind': 'route' }),
            h('span', { key: 'r2', className: 'kb-muted' }, '实线＝路由（这件事去读哪份）'),
            h('span', { key: 'v1', className: 'kb-legend-swatch', 'data-kind': 'valve' }),
            h('span', { key: 'v2', className: 'kb-muted' }, '虚线＝阀门（这条硬检查管哪些文件）'),
            h('span', { key: 'c1', className: 'kb-legend-swatch', 'data-kind': 'cat' }),
            h('span', { key: 'c2', className: 'kb-muted' }, '细实线＝分类（属于哪个 Agent）'),
            h('span', { key: 'f1', className: 'kb-legend-swatch', 'data-kind': 'ref' }),
            h('span', { key: 'f2', className: 'kb-muted' }, '点线＝引用（正文点名了它）'),
            h('span', { key: 'p1', className: 'kb-legend-swatch', 'data-kind': 'plugin' }),
            h('span', { key: 'p2', className: 'kb-muted' }, '双线框＝插件（归属文档下面挂的就是它）'),
            h('span', { key: 's1', className: 'kb-legend-swatch', 'data-kind': 'status' }),
            h('span', { key: 's2', className: 'kb-muted' }, '节点左侧竖条＝状态（红 必截断／橙 偏多／绿 合适／灰 没引用）'),
          ]),
          h('div', { key: 'focusbar', className: 'kb-focusbar' }, [
            h('span', { key: 'v', className: 'kb-muted', style: { marginLeft: 'auto' } }, 'v' + BUILD),
            h('span', { key: 'b', className: 'kb-focusbadge' }, graph.focus?.id === data.nodes.find((node) => node.kind === 'root')?.id ? '总览' : '已聚焦'),
            h('span', { key: 'n', className: 'kb-focusname' }, graph.focus?.label ?? ''),
            h('span', { key: 'c', className: 'kb-muted' }, (() => {
              const focusX = graph.positioned.get(graph.focus?.id)?.x ?? 0
              let up = 0
              let down = 0
              for (const entry of graph.positioned.values()) {
                if (entry.node.id === graph.focus?.id) continue
                if (entry.x < focusX) up += 1
                else if (entry.x > focusX) down += 1
              }
              if (up === 0 && down === 0) return '这条既没有路由指向它、也没有阀门管它（孤立节点）'
              return '上级 ' + up + ' · 下级 ' + down + '（点节点换中心，点线看关系）'
            })()),
          ]),
          h('select', {
            key: 'pick', className: 'kb-select',
            value: graph.focus?.kind === 'file' ? graph.focus.id : '',
            onChange: (event) => {
              const id = event.target.value
              if (!id) return
              setPick({ kind: 'node', id })
              if (onFocus) onFocus(id)
              const node = graph.nodeById.get(id)
              if (node && onFocusNode) onFocusNode(node)
            },
          }, [
            h('option', { key: 'none', value: '' }, '聚焦到…'),
            ...graph.nodeById && data.nodes.filter((node) => node.kind === 'file').map((node) => h('option', { key: node.id, value: node.id }, node.label)),
          ]),
          h('div', { key: 'crumb', className: 'kb-crumb' }, (() => {
            const chain = []
            let id = graph.focus?.id
            const guard = new Set()
            while (id && !guard.has(id)) {
              guard.add(id)
              const node = graph.nodeById.get(id)
              if (!node) break
              chain.unshift(node)
              const parents = graph.parentsOf.get(id) ?? []
              const up = parents.find((edge) => edge.kind === 'route') ?? parents[0]
              id = up?.from
            }
            return chain.map((node, index) => h('button', {
              key: node.id, className: 'kb-crumb-item', disabled: index === chain.length - 1,
              onClick: () => { setPick(null); onFocus(node.id) },
            }, (index === 0 ? '' : '› ') + node.label))
          })()),
          h('button', { key: 'rf', className: 'kb-btn', 'data-on': showRefLines ? '1' : '0', onClick: () => setShowRefLines(!showRefLines) }, showRefLines ? '隐藏引用线' : '显示引用线'),
          h('button', { key: 'l', className: 'kb-btn', 'data-on': showLabels ? '1' : '0', onClick: () => setShowLabels(!showLabels) }, showLabels ? '隐藏线标签' : '显示线标签'),
          h('button', { key: 'z', className: 'kb-btn', onClick: () => { setPan({ x: 0, y: 0 }); setZoom(1) } }, '回到原位'),
          h('button', { key: 'root', className: 'kb-btn', onClick: () => { onFocus(rootNode?.id ?? null); setPick(null) } }, '回到 AGENTS.md'),
        ]),
        h('div', {
          key: 'cv', className: 'kb-canvas', ref: canvasRef,
          onPointerDown: startPan, onPointerMove: movePan, onPointerUp: endPan, onPointerLeave: endPan, onWheel,
        }, [
          h('div', { key: 'inner', className: 'kb-canvas-inner', style: { transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')' } }, [
            h('svg', { key: 'svg', className: 'kb-canvas-svg', width: 4000, height: 3000 }, graph.edges.map((edge) => {
              const path = edgePath(edge)
              if (!path) return null
              if (edge.kind === 'ref' && !showRefLines) return null
              const active = pick?.kind === 'edge' && pick.id === edge.id
              return h('g', { key: edge.id }, [
                h('path', {
                  key: 'p', d: path.d, className: 'kb-edge', 'data-kind': edge.kind, 'data-on': active ? '1' : '0',
                  onPointerDown: (event) => { event.stopPropagation(); setPick({ kind: 'edge', id: edge.id }) },
                }),
                showLabels || active ? h('text', { key: 't', x: path.mid.x, y: path.mid.y - 4, className: 'kb-edge-label' }, String(edge.label ?? '').slice(0, 24)) : null,
              ])
            })),
            ...[...graph.positioned.values()].map((entry) => h('div', {
              key: entry.node.id,
              className: 'kb-node',
              'data-kind': entry.node.kind,
              'data-status': entry.node.kind === 'file' ? (entry.node.sizeStat ?? 'ok') : 'none',
              'data-on': (graph.focus?.id === entry.node.id || (pick?.kind === 'node' && pick.id === entry.node.id)) ? '1' : '0',
              style: { left: entry.x + 'px', top: entry.y + 'px', width: NODE_W + 'px', height: NODE_H + 'px' },
              onContextMenu: (event) => {
                event.preventDefault()
                event.stopPropagation()
                setPick({ kind: 'node', id: entry.node.id })
                onMenu?.(event, entry.node)
              },
              onPointerDown: (event) => {
                event.stopPropagation()
                setPick({ kind: 'node', id: entry.node.id })
                if (onFocus) onFocus(entry.node.id)
                if (onFocusNode) onFocusNode(entry.node)
              },
              onClick: (event) => {
                event.stopPropagation()
                setPick({ kind: 'node', id: entry.node.id })
                if (onFocus) onFocus(entry.node.id)
                if (onFocusNode) onFocusNode(entry.node)
              },
            }, [
              h('span', { key: 'l', className: 'kb-node-label' }, entry.node.label),
              h('span', { key: 's', className: 'kb-node-sub' }, entry.node.kind === 'file'
                ? ((entry.node.sub ?? '') + (entry.node.chars ? ' · ' + formatChars(entry.node.chars) : ''))
                : (entry.node.sub ?? '')),
            ])),
          ]),
        ]),
        h('div', { key: 'side', className: 'kb-canvas-side' }, [
          h('h4', { key: 'h1' }, '当前聚焦'),
          h('div', { key: 'f', className: 'kb-muted' }, (graph.focus?.label ?? '') + ' · ' + (graph.focus?.sub ?? '')),
          h('div', { key: 'nav', className: 'kb-muted' }, '左边＝上级（往上翻一级），右边＝下级；点一下就换聚焦。点线看这条关系。'),

          pickedNode ? h('div', { key: 'n' }, [
            h('h4', { key: 'h' }, '选中的这条'),
            h('div', { key: 'l', className: 'kb-muted' }, pickedNode.label + (pickedNode.sub ? ' · ' + pickedNode.sub : '')),
            pickedNode.kind === 'file' ? h('div', { key: 'stat', className: 'kb-muted' }, (() => {
              const stat = pickedNode.sizeStat
              const chars = formatChars(pickedNode.chars)
              if (stat === 'hard') return '🔴 ' + chars + '：' + (pickedNode.hard || '超过硬上限，会被截断') + '（100% 出问题，马上改）'
              if (stat === 'heavy') return '🟠 ' + chars + '：偏多，AI 读全文容易顾此失彼，值得精简（不是硬错误）'
              if (stat === 'unused') return '⚪ ' + chars + '：没被路由/阀门/其它文档引用（平时用不到）'
              return '🟢 ' + chars + '：体量合适、且用得上'
            })()) : null,
            pickedNode.kind === 'plugin' ? h('div', { key: 'desc', className: 'kb-muted' }, '干什么：' + (pickedNode.desc || '（文档里没写说明）')) : null,
            pickedNode.kind === 'plugin' ? h('div', { key: 'from', className: 'kb-muted' }, '出处：' + (pickedNode.fromDoc ? '插件归属文档' : '插件清单')) : null,
            pickedNode.kind === 'file' ? h('div', { key: 'inline-edit' }, [
              inline ? h('textarea', {
                key: 'ta', className: 'kb-inline-textarea', spellCheck: false,
                value: inline.content,
                onChange: (event) => setInline({ ...inline, content: event.target.value }),
              }) : h('div', { key: 'load', className: 'kb-muted' }, '正文加载中…'),
              inline ? h('div', { key: 'act', className: 'kb-route-row' }, [
                h('button', { key: 's', className: 'kb-btn kb-btn-primary', disabled: busy === 'inline' || inline.content === inline.saved, onClick: saveInline }, busy === 'inline' ? '保存中…' : '保存'),
                h('button', { key: 'o', className: 'kb-btn', onClick: () => onOpenFile({ id: pickedNode.id, title: pickedNode.label, cat: pickedNode.cat, type: pickedNode.sub, kind: 'core' }) }, '在文件视图打开'),
                h('button', { key: 'ref', className: 'kb-btn', onClick: () => onReference?.({ id: pickedNode.id, label: pickedNode.label, kind: pickedNode.kind, rel: pickedNode.rel }) }, '引用到输入框'),
              ]) : null,
            ]) : null,
            pickedNode.kind === 'file' && !routeInto ? h('div', { key: 'noroute' }, [
              h('h4', { key: 'h' }, '还没有路由指向它'),
              h('div', { key: 't', className: 'kb-muted' }, 'AGENTS.md 的开工索引里没有一行读到它，所以它在总览里不会出现。'),
              h('button', {
                key: 'mk', className: 'kb-btn',
                onClick: () => setForm({ trigger: '（写：这件事一出现就去读' + pickedNode.label + '）', cell: '`' + (pickedNode.rel ?? pickedNode.label + '.md') + '`' }),
              }, '在下面填一条指向它的路由'),
            ]) : null,
            routeInto ? h('div', { key: 'route' }, [
              h('h4', { key: 'h' }, '谁把它路由进来'),
              h('div', { key: 't', className: 'kb-muted' }, String(routeInto.label ?? '')),
              h('button', { key: 'u', className: 'kb-btn', onClick: () => preview({ op: 'update', index: routeInto.rowIndex, trigger: String(routeInto.label ?? ''), cell: '`' + routeInto.target + '`' }) }, '改这条路由'),
              h('button', { key: 'd', className: 'kb-btn', onClick: () => preview({ op: 'delete', index: routeInto.rowIndex }) }, '删这条路由'),
            ]) : null,
          ]) : null,

          pickedEdge ? h('div', { key: 'e' }, [
            h('h4', { key: 'h' }, pickedEdge.kind === 'route' ? '这条路由' : '这条阀门线'),
            pickedEdge.kind === 'route' ? h('div', { key: 't', className: 'kb-muted' }, '触发：' + String(pickedEdge.label ?? '')) : null,
            h('div', { key: 'g', className: 'kb-muted' }, (pickedEdge.kind === 'route' ? '目标：' : '阀门：') + String(pickedEdge.target ?? pickedEdge.label ?? '')),
            pickedEdge.kind === 'route' ? h('button', { key: 'u', className: 'kb-btn', onClick: () => preview({ op: 'update', index: pickedEdge.rowIndex, trigger: String(pickedEdge.label ?? ''), cell: '`' + pickedEdge.target + '`' }) }, '改这条（先看差异）') : null,
            pickedEdge.kind === 'route' ? h('button', { key: 'd', className: 'kb-btn', onClick: () => preview({ op: 'delete', index: pickedEdge.rowIndex }) }, '删这条（先看差异）') : null,
          ]) : null,

          h('div', { key: 'add' }, [
            h('h4', { key: 'h' }, '新增一条路由'),
            h('input', { key: 't', className: 'kb-input', placeholder: '触发：这件事一出现…', value: form.trigger, onChange: (event) => setForm({ trigger: event.target.value, cell: form.cell }) }),
            h('input', { key: 'c', className: 'kb-input', placeholder: '目标：规范\\排版-量化口径.md', value: form.cell, onChange: (event) => setForm({ trigger: form.trigger, cell: event.target.value }) }),
            h('button', {
              key: 'b', className: 'kb-btn kb-btn-primary',
              disabled: !form.trigger.trim() || !form.cell.trim() || busy === 'preview',
              onClick: () => preview({ op: 'add', trigger: form.trigger, cell: form.cell }),
            }, '添加（先看差异）'),
          ]),
        ]),
        diff ? h('div', { key: 'diff', className: 'kb-diff kb-diff-float' }, [
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 } }, '发布后这一片会变成这样'),
          ...diff.map((line, index2) => h('div', { key: 'd-' + index2, className: 'kb-diff-line', 'data-kind': line.kind }, (line.kind === 'before' ? '− ' : '+ ') + line.text)),
          h('div', { key: 'a', className: 'kb-route-row', style: { marginTop: 8 } }, [
            h('button', { key: 'ok', className: 'kb-btn kb-btn-primary', disabled: busy === 'publish', onClick: publish }, busy === 'publish' ? '写入中…' : '确认发布'),
            h('button', { key: 'no', className: 'kb-btn', onClick: () => { setDiff(null); setPending(null) } }, '取消'),
          ]),
        ]) : null,
      ])
    }

    
/**
 * 右键菜单（纯组件，props 全进全出，方便自检直接调）。
 * 三个动作用同一个 referenceInto(target, mode)：draft / new / copy。
 */
function ReferenceMenu({ state, onPick, onCopyPath, onClose }) {
  const target = state?.target ?? {}
  const clamp = (value, limit, size) => Math.min(value, Math.max(8, limit - size))
  return h('div', {
    key: 'menuwrap', className: 'kb-menu-backdrop',
    onMouseDown: () => onClose?.(),
    onContextMenu: (event) => { event.preventDefault(); onClose?.() },
  }, h('div', {
    key: 'menu',
    className: 'kb-menu',
    style: {
      left: clamp(state?.x ?? 0, typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200, 240) + 'px',
      top: clamp(state?.y ?? 0, typeof window !== 'undefined' ? window.innerHeight || 900 : 900, 190) + 'px',
    },
    onMouseDown: (event) => event.stopPropagation(),
  }, [
    h('div', { key: 'h', className: 'kb-menu-title' }, String(target.label ?? '').slice(0, 40)),
    h('button', { key: 'a', className: 'kb-menu-item', onClick: () => onPick?.(target, 'draft') }, [
      h('span', { key: 't' }, '引用到输入框'), h('span', { key: 'd', className: 'kb-menu-hint' }, '当前对话空了就填进去，接着写要求'),
    ]),
    h('button', { key: 'b', className: 'kb-menu-item', onClick: () => onPick?.(target, 'new') }, [
      h('span', { key: 't' }, '新开对话并引用'), h('span', { key: 'd', className: 'kb-menu-hint' }, '换掉空白对话里的旧文字'),
    ]),
    h('button', { key: 'c', className: 'kb-menu-item', onClick: () => onPick?.(target, 'copy') }, [
      h('span', { key: 't' }, '只复制 @引用'), h('span', { key: 'd', className: 'kb-menu-hint' }, '自己粘贴到任意输入框'),
    ]),
    h('button', {
      key: 'e', className: 'kb-menu-item',
      onClick: async () => {
        const abs = await (state?.resolvePath ? state.resolvePath(target) : Promise.resolve(''))
        onClose?.()
        if (abs) await onCopyPath?.(abs, '已复制路径：' + abs)
      },
    }, [h('span', { key: 't' }, '复制文件路径'), h('span', { key: 'd', className: 'kb-menu-hint' }, '给别的工具用')]),
  ]))
}

function KnowledgePanel() {
      const [index, setIndex] = React.useState(null)
      const [error, setError] = React.useState('')
      const [cat, setCat] = React.useState('general')
      const [keyword, setKeyword] = React.useState('')
      const [showRef, setShowRef] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [doc, setDoc] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [links, setLinks] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [history, setHistory] = React.useState([])
      const [hostVersion, setHostVersion] = React.useState('')
      const [guide, setGuide] = React.useState(false)
      const [guideText, setGuideText] = React.useState('')
      const [view, setView] = React.useState('canvas')
      const [focusedId, setFocusedId] = React.useState(null)
      const [menu, setMenu] = React.useState(null)

      // ── 右键引用：把选中文件的绝对路径塞进对话输入框 ──────────
      const absPathOf = React.useCallback(async (target) => {
        if (!target?.id || String(target.id).startsWith('valve|') || target.kind === 'plugin') return ''
        const data = await api('/doc?id=' + encodeURIComponent(target.id))
        return data.path ?? ''
      }, [])

      const copyText = React.useCallback(async (text, okNote) => {
        try {
          await navigator.clipboard.writeText(text)
          setToast(okNote)
        } catch {
          setToast('复制失败，浏览器不让写剪贴板；可以手动从下面这行复制：' + text)
        }
      }, [])

      /**
       * mode='draft'  → 落到对话草稿框（当前那个空白对话；已有文字就接到后面）
       * mode='new'    → 新开一个对话再落进去（把草稿里的旧文字换掉）
       * mode='copy'   → 只复制，不动对话
       */
      const referenceInto = React.useCallback(async (target, mode) => {
        setMenu(null)
        try {
          const abs = await absPathOf(target)
          if (!abs) { setToast('这一条不是文件，引用不了'); return }
          const prompt = buildReferencePrompt(abs)
          if (mode === 'copy') { await copyText(prompt.trimEnd(), '已复制 @引用：' + abs); return }
          const uiWorkspace = CORDIS && typeof CORDIS.get === 'function' ? CORDIS.get('uiWorkspace') : null
          if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
            await copyText(prompt.trimEnd(), '这台机器的界面没有开放对话接口，已把 @引用 复制到剪贴板，去输入框粘贴即可')
            return
          }
          uiWorkspace.startSession(undefined, {
            prompt,
            whenDraftExists: mode === 'new' ? 'replace' : 'append',
          })
          setToast(mode === 'new' ? '已新开对话并放进引用，接着写要求就行' : '已放进对话输入框，接着写要求就行')
        } catch (error) {
          setToast('引用失败：' + (error?.message ?? error))
        }
      }, [absPathOf, copyText])

      const reload = React.useCallback((force) => {
        setBusy('index')
        api(`/index${force ? '?force=1' : ''}`).then((data) => {
          setIndex(data)
          setError('')
        }).catch((err) => setError(String(err.message || err))).finally(() => setBusy(''))
      }, [])

      React.useEffect(() => { reload(false) }, [reload])
      React.useEffect(() => {
        fetch(ROUTE + '/status').then((response) => response.json()).then((data) => setHostVersion(data.version ?? '')).catch(() => {})
      }, [])
      // 打开「接入指南」时才去取全文（host 侧 /guide 返回 markdown）
      React.useEffect(() => {
        if (!guide) return
        fetch(ROUTE + '/guide').then((response) => response.text()).then((text) => setGuideText(text)).catch((error) => setGuideText('取不到接入指南：' + error.message))
      }, [guide])

      // 数据超过 60 秒就自动重拉：防止「重开页面但没刷新」时看到旧列表
      const lastLoad = React.useRef(Date.now())
      React.useEffect(() => {
        if (view === 'files' && index) {
          if (Date.now() - lastLoad.current > 60000) reload(true)
        } else if (index) {
          lastLoad.current = Date.now()
        }
      }, [view, index, reload])

      const flash = (text) => {
        setToast(text)
        window.setTimeout(() => setToast(''), 2600)
      }

      const openDoc = React.useCallback((item) => {
        setSelected(item)
        if (item && !String(item.id ?? '').startsWith('valve|')) setFocusedId(item.id)
        setDoc(null)
        setLinks(null)
        setHistory([])
        api(`/doc?id=${encodeURIComponent(item.id)}`).then((data) => {
          setDoc(data)
          setDraft(data.content ?? '')
        }).catch((err) => flash(`打开失败：${err.message}`))
        api(`/links?id=${encodeURIComponent(item.id)}`).then(setLinks).catch(() => setLinks(null))
        api(`/history?id=${encodeURIComponent(item.id)}`).then((data) => setHistory(data.items ?? [])).catch(() => {})
      }, [])

      const dirty = Boolean(doc) && draft !== (doc.content ?? '')

      const save = React.useCallback(() => {
        if (!doc || doc.readonly || !dirty) return
        setBusy('save')
        api('/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: doc.id, content: draft }),
        }).then(() => {
          setDoc({ ...doc, content: draft })
          flash('已保存（改动前已备份）')
          api(`/history?id=${encodeURIComponent(doc.id)}`).then((res) => setHistory(res.items ?? [])).catch(() => {})
        }).catch((err) => flash(`保存失败：${err.message}`))
          .finally(() => setBusy(''))
      }, [doc, draft, dirty])

      const restore = React.useCallback((at) => {
        if (!doc) return
        setBusy('restore')
        api('/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: doc.id, backup: at }),
        }).then(() => {
          flash(`已还原到 ${at}`)
          openDoc(selected)
        }).catch((err) => flash(`还原失败：${err.message}`))
          .finally(() => setBusy(''))
      }, [doc, selected, openDoc])

      const setKind = React.useCallback((kind) => {
        if (!selected || selected.id.startsWith('valve|')) return
        setBusy('kind')
        api('/override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: selected.id, kind }),
        }).then(() => {
          flash(kind === 'reset' ? '已恢复自动判定' : kind === 'core' ? '已归到规则层' : '已归到参考层')
          reload(true)
          setSelected({ ...selected, kind: kind === 'reset' ? selected.kind : kind })
        }).catch((err) => flash(`改判失败：${err.message}`))
          .finally(() => setBusy(''))
      }, [selected, reload])

      const items = React.useMemo(() => {
        if (!index) return []
        const all = [...index.items, ...(index.valves ?? [])]
        const kw = keyword.trim().toLowerCase()
        return all.filter((item) => {
          if (item.cat !== cat) return false
          if (!showRef && item.kind !== 'core') return false
          if (kw && !(item.title.toLowerCase().includes(kw) || (item.rel ?? '').toLowerCase().includes(kw))) return false
          return true
        })
      }, [index, cat, keyword, showRef])

      const grouped = React.useMemo(() => {
        const order = []
        const map = new Map()
        for (const item of items) {
          const key = item.group ?? '其他'
          if (!map.has(key)) { map.set(key, []); order.push(key) }
          map.get(key).push(item)
        }
        // 「插件归属」排最前，一眼能找到
        order.sort((left, right) => (right === '插件归属' ? 1 : 0) - (left === '插件归属' ? 1 : 0))
        return order.map((key) => ({ key, items: map.get(key) }))
      }, [items])

      if (error) {
        return h('div', { className: 'kb-wrap' }, [
          h(StyleTag, { key: 's' }),
          h('div', { className: 'kb-empty' }, [
            h('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 } }, '知识库打不开'),
            h('div', { key: 'e' }, error),
            h('div', { key: 'h', style: { marginTop: 10 } }, '多半是插件没生效或路由没挂上；刷新页面再试，还不行就查 DSH 日志里的 knowledge-base。'),
          ]),
        ])
      }

      return h('div', { className: 'kb-wrap' }, [
        h(StyleTag, { key: 's' }),
        h('div', { key: 'bar', className: 'kb-bar' }, [
          h('span', { key: 't', className: 'kb-title' }, '知识库'),
          h('span', { key: 'hv', className: 'kb-muted' }, hostVersion ? '主机 v' + hostVersion : ''),
          h('div', { key: 'tabs', className: 'kb-tabs' }, (index?.categories ?? []).map((category) => h('button', {
            key: category.id,
            className: 'kb-tab',
            'data-on': cat === category.id ? '1' : '0',
            onClick: () => setCat(category.id),
          }, `${category.label} ${index?.counts?.[category.id] ?? 0}`))),
          h('input', {
            key: 'search',
            className: 'kb-search',
            placeholder: '搜标题或路径',
            value: keyword,
            onChange: (event) => setKeyword(event.target.value),
          }),
          h('button', {
            key: 'ref',
            className: 'kb-btn',
            'data-on': showRef ? '1' : '0',
            title: '原始简报、学习摘录、案例实测、报告记录——默认不显示',
            onClick: () => setShowRef(!showRef),
          }, showRef ? '隐藏参考与记录' : `显示参考与记录 ${index?.refCounts?.[cat] ?? 0}`),
          h('button', {
            key: 'guide',
            className: 'kb-btn',
            title: '给 AI 读的接入指南：换机器 / 加 Agent / 让插件显示本机知识时，让 AI 读这份',
            onClick: () => setGuide(!guide),
          }, guide ? '关掉接入指南' : '接入指南'),
          h('div', { key: 'stleg', className: 'kb-legend', style: { marginLeft: 4 } }, [
            h('span', { key: 'k7', className: 'kb-ring', 'data-status': 'hard' }),
            h('span', { key: 'k8', className: 'kb-muted' }, '必被截断·马上改'),
            h('span', { key: 'k3', className: 'kb-ring', 'data-status': 'heavy' }),
            h('span', { key: 'k4', className: 'kb-muted' }, '偏多·该注意(>1.2万字)'),
            h('span', { key: 'k1', className: 'kb-ring', 'data-status': 'ok' }),
            h('span', { key: 'k2', className: 'kb-muted' }, '合适'),
            h('span', { key: 'k5', className: 'kb-ring', 'data-status': 'unused' }),
            h('span', { key: 'k6', className: 'kb-muted' }, '没被引用'),
            h('span', { key: 'note', className: 'kb-muted', style: { marginLeft: 6 } }, '（只有这四色；左侧不再有第二个彩色点）'),
          ]),
          h('button', {
            key: 'reload',
            className: 'kb-btn',
            disabled: busy === 'index',
            onClick: () => reload(true),
          }, busy === 'index' ? '扫描中…' : '重新扫描'),
          h('div', { key: 'view', className: 'kb-tabs', style: { marginLeft: 'auto' } }, [
            h('button', { key: 'v1', className: 'kb-tab', 'data-on': view === 'files' ? '1' : '0', onClick: () => setView('files') }, '文件'),
            h('button', { key: 'v3', className: 'kb-tab', 'data-on': view === 'canvas' ? '1' : '0', onClick: () => setView('canvas') }, '画布'),
          ]),
        ]),
        view === 'canvas'
          ? h(CanvasView, { key: 'cv', onMenu: (event, node) => setMenu({ x: event.clientX, y: event.clientY, target: { id: node.id, label: node.label, kind: node.kind, rel: node.rel } }),
            onReference: (node) => referenceInto(node, 'draft'), flash, reload, focusId: focusedId, onFocus: setFocusedId, onOpenFile: (item) => { setView('files'); openDoc(item) }, onFocusNode: (node) => { if (node.kind === 'file') setSelected({ id: node.id, title: node.label, cat: node.cat, type: node.sub, kind: 'core' }) } })
          : view === 'routes'
            ? h(RoutesView, { key: 'rv', flash, reload })
            : h('div', { key: 'body', className: 'kb-body' }, [
          h('div', { key: 'list', className: 'kb-list' }, grouped.length ? grouped.map((group) => [
            h('div', { key: `g-${group.key}`, className: 'kb-group' }, `${group.key} · ${group.items.length}`),
            ...group.items.map((item) => h('div', {
              key: item.id,
              className: 'kb-row',
              'data-on': selected?.id === item.id ? '1' : '0',
              'data-ref': item.kind === 'ref' ? '1' : '0',
              onClick: () => openDoc(item),
              onContextMenu: (event) => {
                event.preventDefault()
                event.stopPropagation()
                setMenu({ x: event.clientX, y: event.clientY, target: { id: item.id, label: item.title, kind: 'file', rel: item.rel } })
              },
              title: item.rel ?? item.valveId,
            }, [
              item.sizeStat ? h('span', {
                key: 'r', className: 'kb-ring', 'data-status': item.sizeStat,
                title: item.sizeStat === 'hard' ? (item.hard || '必被截断')
                  : item.sizeStat === 'heavy' ? `内容 ${formatChars(item.chars)}，超过 1.2 万字，AI 读全文容易执行不到位，建议精简`
                    : item.sizeStat === 'unused' ? '没有被任何路由 / 阀门引用，平时用不到' : (item.chars ? `内容 ${formatChars(item.chars)}，体量合适` : ''),
              }) : null,
              h('span', { key: 't', className: 'kb-row-title' }, item.title),
              item.chars ? h('span', { key: 'c', className: 'kb-chars' }, formatChars(item.chars)) : null,
              h('span', { key: 'y', className: 'kb-type' }, item.type ?? '知识'),
            ])),
          ]) : h('div', { key: 'none', className: 'kb-empty' }, showRef
            ? '这一类还没有条目。切到别的分类，或者点「重新扫描」。'
            : '这一类只剩规则/流程/技能层没有条目；点右上「显示参考与记录」看全量。')),
          h('div', { key: 'main', className: 'kb-main' }, [
            h('div', { key: 'fb', className: 'kb-filebar' }, [
              h('span', { key: 'n', style: { fontWeight: 600 } }, doc ? (selected?.title ?? '') : '没选文件'),
              doc ? h('button', { key: 'q', className: 'kb-btn', onClick: () => referenceInto({ id: selected?.id, label: selected?.title, kind: 'file' }, 'draft') }, '引用到输入框') : null,
              doc ? h('span', { key: 'p', className: 'kb-path' }, doc.path) : null,
              dirty ? h('span', { key: 'x', className: 'kb-dirty' }, '未保存') : null,
              selected && !selected.id?.startsWith('valve|') ? h('select', {
                key: 'cat', className: 'kb-select', value: selected.cat ?? 'general',
                onChange: (event) => {
                  const cat = event.target.value
                  api('/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected.id, cat }) })
                    .then(() => { reload(true); setSelected({ ...selected, cat }) })
                    .catch((err) => flash('改分类失败：' + err.message))
                },
              }, Object.entries(CAT_LABEL).map(([id, label]) => h('option', { key: id, value: id }, label))) : null,
              doc && !doc.readonly ? h('button', {
                key: 'save', className: 'kb-btn kb-btn-primary', disabled: !dirty || busy === 'save', onClick: save,
              }, busy === 'save' ? '保存中…' : '保存') : null,
              doc && !doc.readonly && !selected?.id.startsWith('valve|') ? h('button', {
                key: 'k1', className: 'kb-btn', 'data-on': selected?.kind === 'core' ? '1' : '0',
                disabled: busy === 'kind', onClick: () => setKind('core'),
              }, '归到规则层') : null,
              doc && !doc.readonly && !selected?.id.startsWith('valve|') ? h('button', {
                key: 'k2', className: 'kb-btn', 'data-on': selected?.kind === 'ref' ? '1' : '0',
                disabled: busy === 'kind', onClick: () => setKind('ref'),
              }, '归到参考层') : null,
              selected?.overridden ? h('button', {
                key: 'k3', className: 'kb-btn', disabled: busy === 'kind', onClick: () => setKind('reset'),
              }, '改回自动') : null,
            ]),
            h('div', { key: 'ed', className: 'kb-editor' }, doc
              ? h('textarea', {
                key: 'ta',
                className: 'kb-textarea',
                spellCheck: false,
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save() }
                },
              })
              : h('div', { key: 'ph', className: 'kb-empty' }, '左边点一份文件，这里显示它的原始内容；改完点保存，改之前会自动备份一份。')),
          ]),
          h('div', { key: 'side', className: 'kb-side' }, [
            selected ? h('h4', { key: 'h0' }, '这一条为什么在这里') : null,
            selected ? h('div', { key: 'r0', className: 'kb-muted' }, `${CAT_LABEL[selected.cat] ?? selected.cat} · ${selected.kind === 'core' ? '规则层' : '参考层'} · ${selected.type ?? '知识'}${selected.reason ? ` · ${selected.reason}` : ''}${selected.catReason ? ` · 归属：${selected.catReason}` : ''}`) : null,
            h('h4', { key: 'h1' }, '谁路由到这里'),
            ...(links?.routesIn ?? []).map((route, index2) => h('button', {
              key: `ri-${index2}`, className: 'kb-link', title: `AGENTS.md 第 ${route.line} 行`,
            }, route.trigger)),
            !(links?.routesIn ?? []).length ? h('div', { key: 'ri0', className: 'kb-muted' }, '还没有路由指到它。') : null,
            h('h4', { key: 'h2' }, '管它的阀门'),
            ...(links?.valves ?? []).map((valve) => h('button', {
              key: `v-${valve.id}`, className: 'kb-link', title: valve.coverage,
            }, `${valve.id} → ${valve.script}`)),
            !(links?.valves ?? []).length ? h('div', { key: 'v0', className: 'kb-muted' }, '没有阀门挂在这份文件上。') : null,
            h('h4', { key: 'h3' }, '它引用/被引用'),
            ...(links?.refs ?? []).slice(0, 20).map((ref) => h('button', {
              key: `r-${ref.id}`, className: 'kb-link', onClick: () => openDoc({ id: ref.id, title: ref.title, cat: ref.cat, rel: ref.title, type: '知识', kind: ref.kind }),
            }, ref.title)),
            !(links?.refs ?? []).length ? h('div', { key: 'r1', className: 'kb-muted' }, '正文里没点到别的文件。') : null,
            h('h4', { key: 'h4' }, '历史备份'),
            ...history.map((entry) => h('button', {
              key: `h-${entry.at}`, className: 'kb-link', disabled: busy === 'restore', onClick: () => restore(entry.at),
            }, entry.at.replace(/-/, ' ') + ' · 还原')),
            !history.length ? h('div', { key: 'h5', className: 'kb-muted' }, '还没有备份。第一次保存后才会有。') : null,
            h('div', { key: 'b', className: 'kb-muted', style: { marginTop: 14 } }, `v${BUILD}`),
          ]),
        ]),
        guide ? h('div', { key: 'guide', className: 'kb-guidepanel' }, [
          h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 't', style: { fontWeight: 600 } }, '接入指南（给 AI 读的）'),
            h('button', { key: 'c', className: 'kb-btn', onClick: () => setGuide(false) }, '关掉'),
          ]),
          h('div', { key: 'm', className: 'kb-muted' }, '把这份内容交给另一个 AI，它就知道怎么让插件显示本机的规则 / 知识 / 技能 / 插件 / 路由。也可以直接 GET ' + ROUTE + '/guide。'),
          h('pre', { key: 'p', className: 'kb-guidetext' }, guideText || '加载中…'),
        ]) : null,
        (index?.warnings ?? []).length ? h('div', { key: 'warn', className: 'kb-warnbar' }, [
          h('span', { key: 't', style: { fontWeight: 600 } }, '这台机器上有东西没接上：'),
          ...(index.warnings ?? []).map((line, at) => h('div', { key: 'w' + at, className: 'kb-muted' }, '· ' + line)),
        ]) : null,
        menu ? h(ReferenceMenu, { key: 'menu', state: { ...menu, resolvePath: absPathOf }, onPick: referenceInto, onCopyPath: copyText, onClose: () => setMenu(null) }) : null,
        toast ? h('div', { key: 'toast', className: 'kb-toast' }, toast) : null,
      ])
    }

    return {
      inject: ['slots'],
      __focusSubgraph: focusSubgraph,
      __mentionOfPath: mentionOfPath,
      __ReferenceMenu: ReferenceMenu,
      __buildReferencePrompt: buildReferencePrompt,
      apply(ctx) {
        try {
          CORDIS = ctx
          if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject('sidebar.panellist', () => {
            try {
              ctx.slots.register({ name: 'main', key: 'knowledge' }, KnowledgePanel)
            } catch { /* 面板注册失败不阻塞入口 */ }
            try {
              ctx.slots.register({ name: 'sidebar.panellist', id: 'knowledge', order: 5, label: '知识库' }, SidebarIcon)
            } catch { /* 入口注册失败不影响面板 */ }
          })
        } catch { /* 注册失败只影响界面，不能影响 web boot */ }
      },
    }
  },
})
