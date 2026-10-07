import { defineAsyncComponent, defineComponent, h, markRaw } from 'vue'
import type { Component } from 'vue'

/**
 * 工作对象类型注册表（viewerRegistry）
 *
 * 业务链「类型 → 显示模式」的落点：display 三态对应三种显示模式——
 *   editor：可操作模式（又看又操作，如 document=TipTap、workflow=Vue Flow）
 *   viewer：只读模式（只看不操作，如 code/html/generic 轻量视图）
 *   none  ：后台模式（不进视窗，注册仅为声明该类型存在）
 *
 * 意图分层 = 渲染分层：editor 型注册两个渲染态——
 *   viewComponent  ：轻量视图（默认，廉价渲染，AI 流式写入时节流刷新）
 *   editorComponent：完整编辑器（参与时按需挂载 v-if，退回只看即销毁；状态从真相源重读）
 * viewer/none 型只注册 component。
 *
 * 新类型接入只需一行 registerViewer，布局零改动。
 * 参照 toolUIRegistry.ts 的静态映射思路，升级为注册 API + defineAsyncComponent 懒加载。
 */

export type ViewerDisplay = 'editor' | 'viewer' | 'none'

export interface ViewerEntry {
  /** viewer/none 型的视窗组件 */
  component?: Component
  /** editor 型轻量视图（默认渲染态；缺失时回退 editorComponent 只读形态） */
  viewComponent?: Component
  /** editor 型完整编辑器（intent=参与时按需挂载，退回只看即销毁） */
  editorComponent?: Component
  /** 页签/菜单图标（14px 内联 SVG 组件） */
  icon: Component
  /** 类型显示名（页签条/「工作对象」菜单文案） */
  displayName: string
  /** 显示模式 */
  display: ViewerDisplay
}

export interface RegisteredViewer extends ViewerEntry {
  type: string
}

const registry = new Map<string, ViewerEntry>()

/** 注册工作对象类型视图（同类型重复注册后者覆盖前者） */
export function registerViewer(type: string, entry: ViewerEntry): void {
  registry.set(type, {
    component: entry.component ? markRaw(entry.component) : undefined,
    viewComponent: entry.viewComponent ? markRaw(entry.viewComponent) : undefined,
    editorComponent: entry.editorComponent ? markRaw(entry.editorComponent) : undefined,
    icon: markRaw(entry.icon),
    displayName: entry.displayName,
    display: entry.display
  })
}

/** 按类型取注册条目（未注册返回 undefined） */
export function getViewer(type: string): ViewerEntry | undefined {
  return registry.get(type)
}

/** 全部已注册类型（含 none 型；视窗/菜单侧自行按 display 过滤） */
export function getRegisteredViewers(): RegisteredViewer[] {
  return Array.from(registry.entries()).map(([type, entry]) => ({ type, ...entry }))
}

// ==================== 内置图标（14px 内联 SVG，与 WorkspacePanel 菜单同款图形） ====================

const svgAttrs = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round'
}

const workflowIcon = defineComponent({
  name: 'WorkflowViewerIcon',
  render() {
    return h('svg', svgAttrs, [
      h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }),
      h('circle', { cx: 9, cy: 10, r: 1.8, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 15, cy: 10, r: 1.8, fill: 'currentColor', stroke: 'none' })
    ])
  }
})

const documentIcon = defineComponent({
  name: 'DocumentViewerIcon',
  render() {
    return h('svg', svgAttrs, [
      h('path', { d: 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' })
    ])
  }
})

const codeIcon = defineComponent({
  name: 'CodeViewerIcon',
  render() {
    return h('svg', svgAttrs, [
      h('polyline', { points: '16 18 22 12 16 6' }),
      h('polyline', { points: '8 6 2 12 8 18' })
    ])
  }
})

const htmlIcon = defineComponent({
  name: 'HtmlViewerIcon',
  render() {
    return h('svg', svgAttrs, [
      h('circle', { cx: 12, cy: 12, r: 9 }),
      h('path', { d: 'M3 12h18' }),
      h('path', { d: 'M12 3a15 15 0 0 1 0 18' }),
      h('path', { d: 'M12 3a15 15 0 0 0 0 18' })
    ])
  }
})

const fileIcon = defineComponent({
  name: 'FileViewerIcon',
  render() {
    return h('svg', svgAttrs, [
      h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
      h('polyline', { points: '14 2 14 8 20 8' })
    ])
  }
})

// ==================== 首批静态注册（懒加载：首次打开 dock 页签时才拉取组件 chunk） ====================

// document（editor）：markdown/文本文档；轻量态=markdown 渲染+自绘 diff，参与态=TipTap 完整编辑器
registerViewer('document', {
  viewComponent: defineAsyncComponent(() => import('./components/DocumentLightView.vue')),
  editorComponent: defineAsyncComponent(() => import('./views/WritingView.vue')),
  icon: documentIcon,
  displayName: '写作',
  display: 'editor'
})

// workflow（editor）：agent 工作流；轻量态=同一组件惰性配置（toolbar 隐藏+只读封堵），参与态=完整编辑器
registerViewer('workflow', {
  viewComponent: defineAsyncComponent(() => import('./components/WorkflowLightView.vue')),
  editorComponent: defineAsyncComponent(() => import('./views/WorkflowView.vue')),
  icon: workflowIcon,
  displayName: '工作流',
  display: 'editor'
})

// code（viewer）：代码文件只读视图（保守色表语法高亮 + diff 预览）
registerViewer('code', {
  component: defineAsyncComponent(() => import('./components/CodeLightView.vue')),
  icon: codeIcon,
  displayName: '代码',
  display: 'viewer'
})

// html（viewer）：网页渲染预览（Electron webview）+ 源码切换
registerViewer('html', {
  component: defineAsyncComponent(() => import('./components/HtmlLightView.vue')),
  icon: htmlIcon,
  displayName: '网页',
  display: 'viewer'
})

// generic（viewer 兜底）：未注册专属类型的文件型对象一律落此（文件卡片，可见可审计）
registerViewer('generic', {
  component: defineAsyncComponent(() => import('./components/GenericFileView.vue')),
  icon: fileIcon,
  displayName: '文件',
  display: 'viewer'
})
