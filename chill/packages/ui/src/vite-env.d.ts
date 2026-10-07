/// <reference types="vite/client" />

declare module 'markdown-it' {
  // 无 @types/markdown-it：渲染器只用 constructor/render/use 入口，以宽松类声明收口
  // （class 同时是值与类型，兼容 `new MarkdownIt()` 与 `: MarkdownIt` 两处用法；不新造类型包）
  class MarkdownIt {
    constructor(options?: any)
    use(...args: any[]): MarkdownIt
    render(src: string, env?: any): string
    [key: string]: any
  }
  export default MarkdownIt
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
