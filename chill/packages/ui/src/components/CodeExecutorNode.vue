<template>
  <div class="code-executor-node" :class="[nodeStatusClass, { 'node-collapsed': isCollapsed, 'node-selected': props.selected }]">
    <div class="node-header">
      <div class="node-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
      </div>
      <NodeTitle 
        :title="nodeTitle" 
        @update:title="handleTitleUpdate"
      />
      <div class="node-header-right">
        <label class="header-toggle" title="交互模式">
          <input 
            type="checkbox" 
            v-model="interactiveMode"
            @change="props.data.interactiveMode = interactiveMode"
          />
          <span class="header-toggle-text">交互</span>
        </label>
        <button 
          class="collapse-button" 
          @click="toggleCollapse"
          :title="isCollapsed ? '展开' : '折叠'"
        >
          <svg v-if="!isCollapsed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div class="node-status" :class="statusClass">
          {{ statusText }}
        </div>
        <button 
          v-show="!isCollapsed && nodeStatus !== 'running'"
          class="execute-button" 
          @click="handleExecute"
          :disabled="!hasUpstreamOutput"
          :title="!hasUpstreamOutput ? '需要上游节点输出' : '执行代码'"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
        <button 
          v-show="!isCollapsed && nodeStatus === 'running'"
          class="stop-button" 
          @click="handleStop"
          title="停止执行"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="node-content" v-show="!isCollapsed">
      <div class="code-info-container">
        <div class="code-preview" v-if="upstreamOutput" @wheel.stop @mousedown.stop>
          <div class="preview-header">
            <select 
              v-model="selectedLanguage" 
              class="preview-language-select"
              @change="props.data.defaultLanguage = selectedLanguage || undefined"
              title="默认语言"
            >
              <option 
                v-for="option in displayLanguageOptions" 
                :key="option.value" 
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <button 
              class="copy-button" 
              @click="handleCopyCode"
              :title="isCopied ? '已复制' : '复制代码'"
            >
              <svg v-if="isCopied" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a6e3a1" stroke-width="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          </div>
          <pre class="preview-content">{{ codePreview }}</pre>
        </div>
        
        <div class="result-container" v-if="showTerminal" @mousedown.stop>
          <div class="result-header">
            <span class="result-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="4 17 10 11 4 5"/>
                <line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
            </span>
            <span>执行结果</span>
            <button 
              class="clear-button" 
              @click="handleClear"
              title="清空结果"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div ref="terminalContainer" class="terminal-container"></div>
        </div>
      </div>
    </div>
    
    <div v-if="isCollapsed && showTerminal" class="collapsed-result">
      <button 
        class="collapsed-clear-button" 
        @click.stop="handleClear"
        title="清空结果"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div class="collapsed-terminal-hint">
        <span v-if="nodeStatus === 'running'" class="running-hint">
          <span class="status-dot running"></span>
          交互式终端运行中，请展开查看
        </span>
        <span v-else-if="nodeStatus === 'completed'" class="completed-hint">
          <span class="status-dot completed"></span>
          执行完成，请展开查看结果
        </span>
        <span v-else-if="nodeStatus === 'error'" class="error-hint">
          <span class="status-dot error"></span>
          执行出错，请展开查看详情
        </span>
        <span v-else class="idle-hint">
          <span class="status-dot idle"></span>
          终端已就绪
        </span>
      </div>
    </div>
    
    <Handle type="target" id="code-target" :position="Position.Left" />
    <Handle type="source" id="code-source" :position="Position.Right" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, nextTick, type Ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import type { NodeProps } from '@vue-flow/core'
import NodeTitle from './NodeTitle.vue'
import type { ContentBlock, CodeExecutorNodeData, WorkflowNode, SupportedLanguage, NamespacedWorkflowEventBus } from '@assistant-ai/core'
import { ContentBlockType, parseCode, workflowEventBus, WORKFLOW_EVENTS } from '@assistant-ai/core'
import { useWorkflowStore } from '../stores/workflowStore'
import { getHostAPI } from '../host/hostApi'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface WorkflowContext {
  workflowId: string
  eventBus: NamespacedWorkflowEventBus
  getUpstreamNode?: (nodeId: string) => WorkflowNode | null
  getUpstreamOutput?: (nodeId: string) => string | null
}

const props = defineProps<NodeProps<CodeExecutorNodeData>>()

const nodeTitle = ref(props.data.label || '代码执行器')
const nodeStatus = ref<'idle' | 'running' | 'completed' | 'error'>('idle')
const resultType = ref<'text' | 'file'>('text')
const contentBlocks = ref<ContentBlock[]>([])
const isCollapsed = ref(props.data.isCollapsed !== undefined ? props.data.isCollapsed : true)
const isCopied = ref(false)
const selectedLanguage = ref<SupportedLanguage | ''>(props.data.defaultLanguage || '')
const interactiveMode = ref(props.data.interactiveMode || false)

const terminalContainer = ref<HTMLElement | null>(null)
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let currentProcessId: string | null = null
let currentLineBuffer: string[] = []

const showTerminal = ref(false)

const LANGUAGE_OPTIONS: { value: SupportedLanguage | '', label: string }[] = [
  { value: '', label: '自动检测' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'shell', label: 'Shell/Bash' },
  { value: 'powershell', label: 'PowerShell' }
]

const languageLabelMap: Record<string, string> = {
  javascript: 'JavaScript',
  python: 'Python',
  typescript: 'TypeScript',
  shell: 'Shell/Bash',
  powershell: 'PowerShell'
}

const detectedLanguage = ref<string>('')

const displayLanguageOptions = computed(() => {
  const options = [...LANGUAGE_OPTIONS]
  if (detectedLanguage.value) {
    const detectedLabel = languageLabelMap[detectedLanguage.value] || detectedLanguage.value
    options[0] = { value: '', label: `自动检测 (${detectedLabel})` }
    const exists = options.some(opt => opt.value === detectedLanguage.value)
    if (!exists) {
      options.push({ value: detectedLanguage.value as SupportedLanguage, label: detectedLabel })
    }
  }
  return options
})

const injectedContext = inject<WorkflowContext | Ref<WorkflowContext> | undefined>('workflowContext', undefined)

const workflowContext = computed<WorkflowContext | undefined>(() => {
  if (!injectedContext) return undefined
  if ('value' in injectedContext) {
    return (injectedContext as Ref<WorkflowContext>).value
  }
  return injectedContext as WorkflowContext
})

let currentEventBusInstance = workflowContext.value?.eventBus || workflowEventBus

const upstreamOutput = computed<string | null>(() => {
  return workflowContext.value?.getUpstreamOutput?.(props.id) || null
})

const hasUpstreamOutput = computed(() => {
  return upstreamOutput.value !== null && upstreamOutput.value.length > 0
})

const codePreview = computed(() => {
  if (!upstreamOutput.value) return ''
  const parsed = parseCode(upstreamOutput.value)
  return parsed.code
})

watch(() => upstreamOutput.value, (newOutput) => {
  if (newOutput) {
    const parsed = parseCode(newOutput)
    detectedLanguage.value = parsed.language
  } else {
    detectedLanguage.value = ''
  }
}, { immediate: true })

const statusClass = computed(() => `status-${nodeStatus.value}`)
const nodeStatusClass = computed(() => `node-${nodeStatus.value}`)

const statusText = computed(() => {
  const statusMap: Record<string, string> = {
    idle: '就绪',
    running: '运行中',
    completed: '完成',
    error: '错误'
  }
  return statusMap[nodeStatus.value] || '未知'
})

const handleTitleUpdate = (newTitle: string) => {
  nodeTitle.value = newTitle
  props.data.label = newTitle
}

function getCharDisplayWidth(char: string): number {
  const code = char.charCodeAt(0)
  if (code >= 0x4E00 && code <= 0x9FFF) return 2
  if (code >= 0x3400 && code <= 0x4DBF) return 2
  if (code >= 0x20000 && code <= 0x2A6DF) return 2
  if (code >= 0xF900 && code <= 0xFAFF) return 2
  if (code >= 0x2E80 && code <= 0x2EFF) return 2
  if (code >= 0x3000 && code <= 0x303F) return 2
  if (code >= 0xFF00 && code <= 0xFFEF) return 2
  return 1
}

// 统一的终端输入处理函数
const setupTerminalInputHandler = (term: Terminal, processId: string) => {
  term.onData((data) => {
    if (currentProcessId === processId) {
      const isBackspace = data === '\x7f' || data === '\x08'
      const isEnter = data === '\r' || data === '\n'
      
      if (isBackspace) {
        if (currentLineBuffer.length === 0) return
        const removedChar = currentLineBuffer.pop()
        const width = removedChar ? getCharDisplayWidth(removedChar) : 1
        const backspaceSequence = '\x08 \x08'.repeat(width)
        term.write(backspaceSequence)
        term.scrollToBottom()
        return
      }
      
      if (isEnter) {
        const lineToSend = currentLineBuffer.join('') + '\n'
        currentLineBuffer = []
        term.write('\r\n')
        term.scrollToBottom()
        getHostAPI().sendInput(processId, lineToSend).catch(() => {
          term.write('\r\n\x1b[31m输入发送失败，进程可能已退出\x1b[0m')
          term.scrollToBottom()
        })
        return
      }
      
      for (const char of data) {
        currentLineBuffer.push(char)
      }
      term.write(data)
      term.scrollToBottom()
    }
  })
}

const handleCopyCode = async () => {
  if (!upstreamOutput.value) return
  
  try {
    await navigator.clipboard.writeText(upstreamOutput.value)
    isCopied.value = true
    setTimeout(() => {
      isCopied.value = false
    }, 1500)
  } catch (error) {
    console.error('复制失败:', error)
  }
}

const handleExecute = async () => {
  if (!hasUpstreamOutput.value) return

  nodeStatus.value = 'running'
  showTerminal.value = true
  
  await nextTick()
  initTerminal()

  const parsed = parseCode(upstreamOutput.value!)
  const language = selectedLanguage.value || parsed.language

  try {
    const result = await getHostAPI().startInteractiveExecution(
      parsed.code,
      language,
      { timeout: 30000 }
    )

    if (result.success && result.processId) {
      currentProcessId = result.processId
      
      if (terminal) {
        setupTerminalInputHandler(terminal, currentProcessId)
      }

      getHostAPI().onOutput((data) => {
        if (data.processId === currentProcessId && terminal) {
          const term = terminal
          term.write(data.data, () => {
            term.scrollToBottom()
            currentLineBuffer = []
          })
        }
      })

      getHostAPI().onExit((data) => {
        if (data.processId === currentProcessId) {
          if (data.code !== 0) {
            terminal?.write(`\r\n\x1b[31m进程退出，代码: ${data.code}\x1b[0m`)
            if (data.error) {
              terminal?.write(`\r\n\x1b[31m错误: ${data.error}\x1b[0m`)
            }
            terminal?.scrollToBottom()
            nodeStatus.value = 'error'
          } else {
            terminal?.write('\r\n\x1b[32m进程已完成\x1b[0m')
            terminal?.scrollToBottom()
            nodeStatus.value = 'completed'
          }
          currentProcessId = null
        }
      })
    } else {
      nodeStatus.value = 'error'
      if (terminal) {
        terminal.write(`\x1b[31m启动失败: ${result.error || '未知错误'}\x1b[0m`)
        terminal.scrollToBottom()
      }
    }
  } catch (error) {
    nodeStatus.value = 'error'
    if (terminal) {
      terminal.write(`\x1b[31m执行异常: ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
      terminal.scrollToBottom()
    }
  }
}

const handleStop = async () => {
  if (currentProcessId) {
    try {
      await getHostAPI().terminateProcess(currentProcessId)
      if (terminal) {
        terminal.write('\r\n\x1b[33m进程已终止\x1b[0m')
        terminal.scrollToBottom()
      }
      currentProcessId = null
      nodeStatus.value = 'idle'
    } catch (error) {
      console.error('[CodeExecutor] 终止进程失败:', error)
    }
  }
}

const handleClear = () => {
  resultType.value = 'text'
  contentBlocks.value = []
  nodeStatus.value = 'idle'
  props.data.executionResult = undefined
  showTerminal.value = false
  destroyTerminal()
}

const initTerminal = () => {
  if (!terminalContainer.value) return

  if (terminal) {
    destroyTerminal()
  }

  terminal = new Terminal({
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    },
    fontFamily: 'Consolas, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollOnUserInput: true
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalContainer.value)
  
  nextTick(() => {
    fitAddon?.fit()
  })
}

const destroyTerminal = () => {
  if (terminal) {
    terminal.dispose()
    terminal = null
    fitAddon = null
  }
  currentProcessId = null
}

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  props.data.isCollapsed = isCollapsed.value
}

const initializeFromProps = () => {
  nodeTitle.value = props.data.label || '代码执行器'
  isCollapsed.value = props.data.isCollapsed !== undefined ? props.data.isCollapsed : true
  selectedLanguage.value = props.data.defaultLanguage || ''

  if (props.data.executionResult) {
    nodeStatus.value = props.data.executionResult.nodeStatus
    resultType.value = props.data.executionResult.resultType
    contentBlocks.value = props.data.executionResult.contentBlocks || []
  } else {
    nodeStatus.value = 'idle'
    resultType.value = 'text'
    contentBlocks.value = []
  }
}

const handleNodeStarted = (data: { nodeId: string }) => {
  if (data.nodeId === props.id) {
    nodeStatus.value = 'running'
    resultType.value = 'text'
    contentBlocks.value = []
  }
}

const handleInterrupt = async (data: { type: string; code: string; language: string; autoDetected?: boolean }) => {
  console.log('=== DEBUG HITL === handleInterrupt 被调用: data=', data)
  if (data.type === 'executing') {
    if (data.autoDetected) {
      interactiveMode.value = true
      props.data.interactiveMode = true
    }
    console.log('=== DEBUG HITL === handleInterrupt: type=executing, 准备启动交互执行')
    nodeStatus.value = 'running'
    showTerminal.value = true
    await nextTick()
    initTerminal()

    try {
      console.log('=== DEBUG HITL === handleInterrupt: 调用 parseCode 解析代码')
      const parsed = parseCode(data.code)
      console.log('=== DEBUG HITL === handleInterrupt: 解析后 code=', parsed.code, 'language=', parsed.language)
      
      console.log('=== DEBUG HITL === handleInterrupt: 调用 startInteractiveExecution')
      const result = await getHostAPI().startInteractiveExecution(
        parsed.code,
        parsed.language,
        { timeout: 30000 }
      )
      console.log('=== DEBUG HITL === handleInterrupt: startInteractiveExecution result=', result)

      if (result.success && result.processId) {
        console.log('=== DEBUG HITL === handleInterrupt: 进程启动成功, processId=', result.processId)
        currentProcessId = result.processId

        console.log('=== DEBUG HITL === handleInterrupt: 准备注册 onOutput 和 onExit 监听器')

        if (terminal) {
          setupTerminalInputHandler(terminal, currentProcessId)
        }

        getHostAPI().onOutput((outputData) => {
          console.log('=== DEBUG HITL === onOutput 被调用: outputData=', outputData, 'currentProcessId=', currentProcessId)
          if (outputData.processId === currentProcessId && terminal) {
            const term = terminal
            term.write(outputData.data, () => {
              term.scrollToBottom()
              currentLineBuffer = []
            })
          }
        })

        getHostAPI().onExit((exitData) => {
          console.log('=== DEBUG HITL === onExit 被调用: exitData=', exitData, 'currentProcessId=', currentProcessId)
          if (exitData.processId === currentProcessId) {
            console.log('=== DEBUG HITL === handleInterrupt: onExit 匹配 processId, 准备调用 resumeWorkflow')
            if (exitData.code !== 0) {
              terminal?.write(`\r\n\x1b[31m进程退出，代码: ${exitData.code}\x1b[0m`)
              if (exitData.error) {
                terminal?.write(`\r\n\x1b[31m错误: ${exitData.error}\x1b[0m`)
              }
              nodeStatus.value = 'error'
            } else {
              terminal?.write('\r\n\x1b[32m进程已完成\x1b[0m')
              nodeStatus.value = 'completed'
            }
            currentProcessId = null

            const workflowStore = useWorkflowStore()
            const output = terminal?.buffer.active.getLine(0)?.translateToString() || ''
            console.log('=== DEBUG HITL === handleInterrupt: 调用 resumeWorkflow')
            workflowStore.resumeWorkflow({
              completed: true,
              output,
              exitCode: exitData.code
            }, workflowContext.value?.workflowId)
          }
        })
      } else {
        nodeStatus.value = 'error'
        if (terminal) {
          terminal.write(`\x1b[31m启动失败: ${result.error || '未知错误'}\x1b[0m`)
        }
      }
    } catch (error) {
      nodeStatus.value = 'error'
      if (terminal) {
        terminal.write(`\x1b[31m执行异常: ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
      }
    }
  }
}

const handleNodeCompleted = async (data: { nodeId: string; result?: any; values?: any }) => {
  if (data.nodeId === props.id) {
    if (data.result && data.result.messages) {
      const messages = data.result.messages
      const codeMessages = messages.filter((msg: any) => 
        msg.content.includes('[代码执行结果]') || msg.content.includes('[代码执行失败]')
      )
      
      if (codeMessages.length > 0) {
        showTerminal.value = true
        await nextTick()
        if (!terminal) {
          initTerminal()
        }
        
        const blocks: ContentBlock[] = []
        const lastMessage = codeMessages[codeMessages.length - 1]
        
        if (lastMessage.content.includes('[代码执行失败]')) {
          nodeStatus.value = 'error'
        } else {
          nodeStatus.value = 'completed'
        }
        
        codeMessages.forEach((msg: any, index: number) => {
          const content = msg.content || '(无返回内容)'
          blocks.push({
            id: `code-result-${index}`,
            type: ContentBlockType.TEXT,
            position: index,
            content
          })
          if (terminal) {
            terminal.write(content + '\r\n')
          }
        })
        contentBlocks.value = blocks
      }
    }
  }
}

onMounted(() => {
  initializeFromProps()
  
  currentEventBusInstance = workflowContext.value?.eventBus || workflowEventBus

  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  currentEventBusInstance.on(WORKFLOW_EVENTS.INTERRUPT, handleInterrupt)
})

watch(() => props.data, (newData, oldData) => {
  if (newData !== oldData) {
    initializeFromProps()
  }
}, { immediate: true, deep: true })

onUnmounted(() => {
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
  currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
  currentEventBusInstance.off(WORKFLOW_EVENTS.INTERRUPT, handleInterrupt)
  destroyTerminal()
  getHostAPI().removeInteractiveListeners()
})

watch(() => workflowContext.value?.workflowId, (newWorkflowId, oldWorkflowId) => {
  if (newWorkflowId && newWorkflowId !== oldWorkflowId) {
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
    currentEventBusInstance.off(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
    currentEventBusInstance.off(WORKFLOW_EVENTS.INTERRUPT, handleInterrupt)

    currentEventBusInstance = workflowContext.value?.eventBus || workflowEventBus

    currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_STARTED, handleNodeStarted)
    currentEventBusInstance.on(WORKFLOW_EVENTS.NODE_COMPLETED, handleNodeCompleted)
    currentEventBusInstance.on(WORKFLOW_EVENTS.INTERRUPT, handleInterrupt)
  }
})
</script>

<style scoped>
.code-executor-node {
  background: #1e1e2e;
  border: 1px solid #313244;
  border-radius: 8px;
  min-width: 280px;
  max-width: 400px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.node-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: #313244;
  border-radius: 8px 8px 0 0;
  gap: 8px;
}

.node-header :deep(.title-text) {
  color: #cdd6f4;
}

.node-header :deep(.title-text:hover) {
  background-color: #45475a;
}

.node-icon {
  color: #89b4fa;
  flex-shrink: 0;
}

.node-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.header-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 11px;
  color: #a6adc8;
  user-select: none;
}

.header-toggle input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  accent-color: #89b4fa;
}

.header-toggle:hover {
  color: #cdd6f4;
}

.collapse-button,
.execute-button,
.stop-button,
.clear-button {
  background: transparent;
  border: none;
  color: #cdd6f4;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.collapse-button:hover,
.execute-button:hover,
.stop-button:hover,
.clear-button:hover {
  background: #45475a;
}

.stop-button {
  color: #f38ba8;
}

.stop-button:hover {
  background: #f38ba8;
  color: #1e1e2e;
}

.execute-button:disabled {
  color: #6c7086;
  cursor: not-allowed;
}

.node-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.status-idle { background: #45475a; color: #a6adc8; }
.status-running { background: #f9e2af; color: #1e1e2e; }
.status-completed { background: #a6e3a1; color: #1e1e2e; }
.status-error { background: #f38ba8; color: #1e1e2e; }

.node-content {
  padding: 12px;
}

.code-info-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.upstream-info {
  font-size: 12px;
  color: #a6adc8;
}

.info-label {
  margin-right: 4px;
}

.info-label.warning {
  color: #f9e2af;
}

.info-value {
  color: #cdd6f4;
}

.code-preview {
  background: #181825;
  border-radius: 6px;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: #313244;
  font-size: 11px;
  color: #a6adc8;
}

.preview-language-select {
  background: transparent;
  border: 1px solid transparent;
  color: #a6adc8;
  font-size: 11px;
  padding: 2px 18px 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a6adc8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 2px center;
}

.preview-language-select:hover {
  border-color: #45475a;
  color: #cdd6f4;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23cdd6f4' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
}

.preview-language-select:focus {
  border-color: #89b4fa;
}

.copy-button {
  background: transparent;
  border: none;
  color: #a6adc8;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.copy-button:hover {
  color: #cdd6f4;
  background: #45475a;
}

.preview-content {
  padding: 8px 10px;
  margin: 0;
  font-size: 11px;
  color: #cdd6f4;
  font-family: 'Fira Code', 'Consolas', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  cursor: text;
  user-select: text;
}

.result-container {
  background: #181825;
  border-radius: 6px;
  overflow: hidden;
  cursor: text;
  user-select: text;
}

.terminal-container {
  height: 200px;
  padding: 8px;
  overflow: hidden;
}

.result-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  background: #313244;
  font-size: 12px;
  color: #cdd6f4;
  gap: 6px;
}

.result-icon {
  color: #89b4fa;
}

.clear-button {
  margin-left: auto;
}

.collapsed-result {
  padding: 8px;
  position: relative;
}

.collapsed-terminal-hint {
  padding: 12px;
  font-size: 12px;
  color: #a6adc8;
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.status-dot.running {
  background: #f9e2af;
  animation: pulse 1.5s infinite;
}

.status-dot.completed {
  background: #a6e3a1;
}

.status-dot.error {
  background: #f38ba8;
}

.status-dot.idle {
  background: #6c7086;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.collapsed-result :deep(.text-content) {
  color: #cdd6f4;
  cursor: text;
  user-select: text;
}

.collapsed-result :deep(.empty-result) {
  color: #6c7086;
}

.collapsed-clear-button {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(30, 30, 46, 0.8);
  border: none;
  color: #cdd6f4;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  z-index: 10;
}

.collapsed-clear-button:hover {
  background: #45475a;
}

.code-executor-node.node-collapsed {
  width: auto;
  min-width: 120px;
  max-width: 300px;
  position: relative;
}

.node-collapsed .node-header {
  border-radius: 8px;
}

.node-selected {
  border-color: #89b4fa;
  box-shadow: 0 0 0 1px #89b4fa;
}

.node-running {
  border-color: #f9e2af;
}

.node-completed {
  border-color: #a6e3a1;
}

.node-error {
  border-color: #f38ba8;
}
</style>
