import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export interface DiffOperation {
  type: 'insert' | 'delete' | 'replace' | 'preview_file'
  from: number
  to: number
  plainTextFrom?: number
  plainTextTo?: number
  insertContent?: string
  deleteContent?: string
}

export interface DiffPreviewState {
  operations: DiffOperation[]
}

export type DiffPreviewMetaType = 'add' | 'set' | 'clear'

export interface DiffPreviewMeta {
  type?: DiffPreviewMetaType
  operations?: DiffOperation[]
}

export const DiffPreviewPluginKey = new PluginKey<DiffPreviewState>('diffPreview')

export const DiffPreviewExtension = Extension.create({
  name: 'diffPreview',

  addProseMirrorPlugins() {
    return [
      new Plugin<DiffPreviewState>({
        key: DiffPreviewPluginKey,
        state: {
          init: () => {
            return {
              operations: [] as DiffOperation[],
            }
          },
          apply: (tr, prevState) => {
            const meta = tr.getMeta(DiffPreviewPluginKey) as DiffPreviewMeta | undefined
            if (meta === undefined) {
              return prevState
            }
            
            if (meta.type === 'clear') {
              return { operations: [] }
            }
            
            if (meta.type === 'add' && meta.operations) {
              return {
                operations: [...prevState.operations, ...meta.operations]
              }
            }
            
            if (meta.type === 'set' && meta.operations) {
              return { operations: meta.operations }
            }
            
            if (meta.operations !== undefined) {
              return { operations: meta.operations }
            }
            
            return prevState
          },
        },
        props: {
          decorations: (state) => {
            const pluginState = DiffPreviewPluginKey.getState(state)
            
            if (!pluginState || !pluginState.operations || pluginState.operations.length === 0) {
              return DecorationSet.empty
            }

            const { operations } = pluginState
            const decorations: Decoration[] = []
            const docSize = state.doc.content.size

            operations.forEach((op) => {
              if (op.type === 'preview_file') {
                const from = Math.min(op.from, docSize)
                const to = Math.min(op.to, docSize)
                if (from < to) {
                  decorations.push(
                    Decoration.inline(from, to, {
                      class: 'preview-file-decoration',
                      style: 'background-color: #bbf7d0; border-radius: 3px;',
                    })
                  )
                }
              } else if (op.type === 'insert') {
                const from = Math.min(op.from, docSize)
                decorations.push(
                  Decoration.widget(from, () => {
                    const el = document.createElement('span')
                    el.style.backgroundColor = '#bbf7d0'
                    el.style.color = '#166534'
                    el.style.padding = '2px 4px'
                    el.style.borderRadius = '3px'
                    el.style.whiteSpace = 'pre-wrap'
                    el.textContent = op.insertContent || ''
                    return el
                  })
                )
              } else if (op.type === 'delete') {
                const from = Math.min(op.from, docSize)
                const to = Math.min(op.to, docSize)
                if (from < to) {
                  if (op.deleteContent !== undefined) {
                    try {
                      const actualText = state.doc.textBetween(from, to)
                      if (actualText !== op.deleteContent) {
                        return
                      }
                    } catch (e) {
                      return
                    }
                  }
                  decorations.push(
                    Decoration.inline(from, to, {
                      style: 'background-color: #fecaca; text-decoration: line-through; color: #991b1b;',
                    })
                  )
                }
              } else if (op.type === 'replace') {
                const from = Math.min(op.from, docSize)
                const to = Math.min(op.to, docSize)
                if (from < to) {
                  if (op.deleteContent !== undefined) {
                    try {
                      const actualText = state.doc.textBetween(from, to)
                      if (actualText !== op.deleteContent) {
                        return
                      }
                    } catch (e) {
                      return
                    }
                  }
                  decorations.push(
                    Decoration.inline(from, to, {
                      style: 'background-color: #fecaca; text-decoration: line-through; color: #991b1b;',
                    })
                  )
                }
                decorations.push(
                  Decoration.widget(to, () => {
                    const el = document.createElement('span')
                    el.style.backgroundColor = '#bbf7d0'
                    el.style.color = '#166534'
                    el.style.padding = '2px 4px'
                    el.style.borderRadius = '3px'
                    el.style.whiteSpace = 'pre-wrap'
                    el.textContent = op.insertContent || ''
                    return el
                  })
                )
              }
            })

            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
