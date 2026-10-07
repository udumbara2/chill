import type { Editor } from '@tiptap/core'
import type { IDocumentSnapshot } from '@assistant-ai/core'

export interface MappingItem {
  plainTextIndex: number
  tipTapPos: number
  char: string
}

export interface DocumentSnapshot extends IDocumentSnapshot {
  plainText: string
  mapping: MappingItem[]
}

export function generateDocumentSnapshot(editor: Editor): DocumentSnapshot {
  if (!editor || !editor.state || !editor.state.doc) {
    return { plainText: '', mapping: [] }
  }

  const { doc } = editor.state
  const mapping: MappingItem[] = []
  let plainTextIndex = 0

  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text || ''
      for (let i = 0; i < text.length; i++) {
        mapping.push({
          plainTextIndex,
          tipTapPos: pos + i,
          char: text[i],
        })
        plainTextIndex++
      }
    } else if (node.isBlock && pos > 0) {
      mapping.push({
        plainTextIndex,
        tipTapPos: pos,
        char: '\n',
      })
      plainTextIndex++
    }
  })

  const plainText = mapping.map((item) => item.char).join('')

  return { plainText, mapping }
}

export function generateVirtualMapping(plainText: string): MappingItem[] {
  const mapping: MappingItem[] = []
  let plainTextIndex = 0
  let tipTapPos = 3
  
  const lines = plainText.split('\n')
  
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    
    for (let i = 0; i < line.length; i++) {
      mapping.push({
        plainTextIndex,
        tipTapPos,
        char: line[i]
      })
      plainTextIndex++
      tipTapPos++
    }
    
    if (lineIndex < lines.length - 1) {
      mapping.push({
        plainTextIndex,
        tipTapPos,
        char: '\n'
      })
      plainTextIndex++
      tipTapPos += 2
    }
  }
  
  return mapping
}

export function createVirtualSnapshot(plainText: string): DocumentSnapshot {
  return {
    plainText,
    mapping: generateVirtualMapping(plainText)
  }
}

export function plainTextIndexToTipTapPos(
  snapshot: DocumentSnapshot,
  plainTextIndex: number
): number | null {
  const item = snapshot.mapping.find((m) => m.plainTextIndex === plainTextIndex)
  return item ? item.tipTapPos : null
}

export function tipTapPosToPlainTextIndex(
  snapshot: DocumentSnapshot,
  tipTapPos: number
): number | null {
  const item = snapshot.mapping.find((m) => m.tipTapPos === tipTapPos)
  return item ? item.plainTextIndex : null
}
