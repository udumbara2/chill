import MarkdownIt from 'markdown-it'
// @ts-ignore - 缺少类型声明
import mk from 'markdown-it-katex'
import anchor from 'markdown-it-anchor'
// @ts-ignore - 缺少类型声明
import taskLists from 'markdown-it-task-lists'

/**
 * MarkdownIt 模块级单例（渲染架构 L4）。
 * markdown-it 的 render 无跨调用可变状态，逐块组件（MarkdownSegment）共享同一实例；
 * 旧实现每 MessageMarkdown 组件实例化一个（含四插件注册），逐块组件化后会乘上块数。
 */
let instance: MarkdownIt | null = null

export function getMarkdownRenderer(): MarkdownIt {
  if (!instance) {
    instance = new MarkdownIt({
      html: true, // 允许HTML标签
      linkify: true, // 自动转换链接
      breaks: true, // 转换换行
    })
    instance.use(mk) // 数学公式支持
    instance.use(anchor, {
      // 锚点链接支持
      slugify: (s: string) => s.replace(/[^\w]+/g, '-'),
      permalink: {
        placement: 'after',
        symbol: '#',
        class: 'header-anchor',
      },
    })
    instance.use(taskLists) // 任务列表支持
  }
  return instance
}
