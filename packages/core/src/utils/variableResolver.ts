export function resolveVariables(
  params: Record<string, any>,
  toolResults: any[],
  state?: any
): Record<string, any> {
  const resolved: Record<string, any> = {}
  
  for (const key in params) {
    const value = params[key]
    resolved[key] = resolveValue(value, toolResults, state)
  }
  
  return resolved
}

function resolveValue(value: any, toolResults: any[], state?: any): any {
  if (typeof value === 'string') {
    return resolveString(value, toolResults, state)
  } else if (Array.isArray(value)) {
    return value.map(item => resolveValue(item, toolResults, state))
  } else if (typeof value === 'object' && value !== null) {
    const resolved: Record<string, any> = {}
    for (const key in value) {
      resolved[key] = resolveValue(value[key], toolResults, state)
    }
    return resolved
  }
  
  return value
}

function resolveString(str: string, toolResults: any[], state?: any): any {
  const toolsPattern = /\{\{tools\[(\d+)\]\.result(?:\.(\w+(?:\.\w+)*))?\}\}/g
  const messagesPattern = /\{\{messages\[(-?\d+)\]\.content\}\}/g
  const textPattern = /\{\{text\}\}/g
  
  let result = str
  let hasVariables = false
  
  result = result.replace(toolsPattern, (match, indexStr, path) => {
    hasVariables = true
    const index = parseInt(indexStr, 10)
    
    if (index < 0 || index >= toolResults.length) {
      console.warn(`Variable reference out of bounds: ${match}`)
      return match
    }
    
    const toolResult = toolResults[index]
    
    if (!path) {
      return JSON.stringify(toolResult)
    }
    
    const pathParts = path.split('.')
    let current: any = toolResult
    
    for (const part of pathParts) {
      if (current === null || current === undefined) {
        console.warn(`Cannot access property '${part}' of null or undefined`)
        return match
      }
      
      if (typeof current === 'object' && part in current) {
        current = current[part]
      } else {
        console.warn(`Property '${part}' not found in tool result`)
        return match
      }
    }
    
    if (typeof current === 'object') {
      return JSON.stringify(current)
    }
    
    return String(current)
  })
  
  result = result.replace(messagesPattern, (match, indexStr) => {
    hasVariables = true
    
    if (!state || !state.messages || !Array.isArray(state.messages)) {
      console.warn(`State or messages not available: ${match}`)
      return match
    }
    
    const messages = state.messages
    let index = parseInt(indexStr, 10)
    
    if (index < 0) {
      index = messages.length + index
    }
    
    if (index < 0 || index >= messages.length) {
      console.warn(`Message index out of bounds: ${match}`)
      return match
    }
    
    const message = messages[index]
    return message.content || ''
  })
  
  result = result.replace(textPattern, () => {
    hasVariables = true
    
    if (!state || state.text === undefined) {
      console.warn(`State text not available`)
      return ''
    }
    
    return state.text
  })
  
  if (hasVariables && result.startsWith('{') && result.endsWith('}')) {
    try {
      return JSON.parse(result)
    } catch {
      return result
    }
  }
  
  return result
}
