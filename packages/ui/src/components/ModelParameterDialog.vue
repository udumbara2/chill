<template>
  <div class="model-parameter-dialog-overlay" v-if="isVisible" @click="closeDialog">
    <div class="model-parameter-dialog" @click.stop>
      <div class="dialog-header">
        <h3>{{ modelDisplayName }} 参数设置</h3>
        <button class="close-button" @click="closeDialog">×</button>
      </div>
      
      <div class="dialog-content">
        <div v-if="loading" class="loading">加载中...</div>
        
        <div v-else-if="parameters.length === 0" class="no-parameters">
          该模型无可调整参数
        </div>
        
        <form v-else class="parameter-form" @submit.prevent="saveParameters">
          <div v-for="(param, _) in filteredParameters" :key="param.name" class="parameter-item">
            <div class="parameter-row">
              <label class="parameter-label">
                {{ param.name }}
                <span class="parameter-description">{{ param.description }}</span>
              </label>
              
              <div class="parameter-input">
                <!-- 数字类型输入 -->
                <div v-if="param.type === ParameterType.NUMBER" class="parameter-input">
                  <input 
                    type="number" 
                    v-model="paramValues[param.name]"
                    :min="getParameterMin(param)"
                    :max="getParameterMax(param)"
                    :step="getParameterStep(param)"
                    class="input-number"
                  />
                </div>
                
                <!-- 布尔类型输入 -->
                <div v-else-if="param.type === ParameterType.BOOLEAN" class="parameter-input">
                  <BooleanParameterToggle 
                    v-model="paramValues[param.name]"
                  />
                </div>
                
                <!-- 字符串类型输入 -->
                <div v-else-if="param.type === ParameterType.STRING" class="parameter-input">
                  <!-- tool_choice参数使用单选按钮组 -->
                  <div v-if="param.name === 'tool_choice'" class="radio-group">
                    <label class="radio-option">
                      <input 
                        type="radio" 
                        value="auto"
                        v-model="paramValues[param.name]"
                        class="input-radio"
                      />
                      <span class="radio-label">自动选择</span>
                    </label>
                    <label class="radio-option">
                      <input 
                        type="radio" 
                        value="none"
                        v-model="paramValues[param.name]"
                        class="input-radio"
                      />
                      <span class="radio-label">不使用工具</span>
                    </label>
                    <label class="radio-option">
                      <input 
                        type="radio" 
                        value="required"
                        v-model="paramValues[param.name]"
                        class="input-radio"
                      />
                      <span class="radio-label">必须使用工具</span>
                    </label>
                  </div>
                  <!-- 其他字符串参数使用文本输入 -->
                  <input 
                    v-else
                    type="text" 
                    v-model="paramValues[param.name]"
                    class="input-text"
                  />
                </div>
                
                <!-- 数组类型输入 -->
                <div v-else-if="param.type === ParameterType.ARRAY" class="parameter-input">
                  <textarea 
                    v-model="paramValues[param.name]"
                    class="input-textarea"
                    rows="3"
                  ></textarea>
                </div>
                
                <!-- 对象类型输入 -->
                <div v-else-if="param.type === ParameterType.OBJECT" class="parameter-input">
                  <!-- thinking参数使用Toggle开关 -->
                  <div v-if="param.name === 'thinking'" class="parameter-input">
                    <BooleanParameterToggle 
                      v-model="paramValues[param.name]"
                    />
                  </div>
                  <!-- response_format参数使用单选按钮组 -->
                  <div v-else-if="param.name === 'response_format'" class="input-radio-group">
                    <label class="radio-label">
                      <input 
                        type="radio" 
                        v-model="paramValues[param.name]"
                        value='{"type":"text"}'
                        class="input-radio"
                      />
                      <span class="radio-text">文本格式</span>
                    </label>
                    <label class="radio-label">
                      <input 
                        type="radio" 
                        v-model="paramValues[param.name]"
                        value='{"type":"json_object"}'
                        class="input-radio"
                      />
                      <span class="radio-text">JSON格式</span>
                    </label>
                  </div>
                  <!-- 其他对象参数使用文本域 -->
                  <textarea 
                    v-else
                    v-model="paramValues[param.name]"
                    class="input-textarea"
                    rows="3"
                  ></textarea>
                </div>
                
                <!-- 默认文本输入 -->
                <div v-else class="parameter-input">
                  <input 
                    type="text" 
                    v-model="paramValues[param.name]"
                    class="input-text"
                  />
                </div>
                
                <div v-if="validationErrors[param.name]" class="error-message">
                  {{ validationErrors[param.name] }}
                </div>
              </div>
            </div>
          </div>
          
          <div class="dialog-actions">
            <button type="button" class="btn-secondary" @click="resetToDefaults">
              重置为默认值
            </button>
            <div class="action-buttons">
              <button type="button" class="btn-secondary" @click="closeDialog">
                取消
              </button>
              <button type="submit" class="btn-primary">
                保存
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { ModelInfoService } from '@assistant-ai/core';
import { SelectedModelsService, ModelParameterSettings } from '@assistant-ai/core';
import { ModelParameter, ParameterType } from '@assistant-ai/core';
import BooleanParameterToggle from './BooleanParameterToggle.vue';

// Props
const props = defineProps<{
  model: any;
}>();

// Emits
const emit = defineEmits<{
  'close': [];
  'save': [modelName: string, parameters: { [key: string]: any }];
}>();

// 响应式数据
const loading = ref(true);
const modelInfo = ref<any>(null);
const parameters = ref<ModelParameter[]>([]);
const paramValues = ref<{ [key: string]: any }>({});
const validationErrors = ref<{ [key: string]: string }>({});

// 计算属性
const isVisible = computed(() => !!props.model);
const modelName = computed(() => props.model?.name || '');
const modelDisplayName = computed(() => {
  const displayName = modelInfo.value?.displayName || props.model?.displayName || '';
  return displayName;
});

const filteredParameters = computed(() => {
    // 如果没有模型信息，返回空数组
    if (!modelInfo.value) {
      return []
    }
    
    // 获取所有参数
    const allParams = parameters.value
    
    // 检查是否有thinking参数
    const hasThinkingParam = allParams.some(param => param.name === 'thinking')
    // 使用变量避免未使用警告
    void hasThinkingParam
    
    const result = allParams.filter(param => {
      // 排除系统参数和tools参数
      if (param.name === 'model' || param.name === 'messages' || param.name === 'tools') {
        return false
      }
      
      // 特殊处理thinking参数：只在实际支持的模型中显示
      if (param.name === 'thinking') {
        const shouldShow = modelInfo.value?.supportsThinking || false
        return shouldShow
      }
      
      // 必需参数只对支持的模型显示
      if (param.required) {
        // 检查模型是否支持该参数
        const isAllowed = !param.forProvider || param.forProvider.includes(modelInfo.value?.type)
        return isAllowed
      }
      
      return true
    })
    
    return result
  })

// 方法
const loadModelInfo = async () => {
  try {
    loading.value = true
    
    if (props.model) {
      modelInfo.value = props.model
    } else {
      const modelInfoService = ModelInfoService.getInstance()
      modelInfo.value = modelName.value ? modelInfoService.getModelInfoByName(modelName.value) : null
    }
    
    if (modelInfo.value) {
      const allParameters = modelInfo.value.supportedParameters || []
      
      // 如果模型支持thinking但参数列表中没有，则添加thinking参数
      let finalParameters = [...allParameters]
      if (modelInfo.value.supportsThinking && !finalParameters.some(p => p.name === 'thinking')) {
        finalParameters.push({
          name: 'thinking',
          type: ParameterType.OBJECT,
          description: '深度思考配置，如{"type": "enabled"}或{"type": "disabled"}',
          required: false
        })
      }
      
      parameters.value = finalParameters.filter(param => {
        // 排除系统参数和tools参数
        if (param.name === 'model' || param.name === 'messages' || param.name === 'tools') {
          return false
        }
        
        // 特殊处理thinking参数：只在实际支持的模型中显示
        if (param.name === 'thinking') {
          const shouldShow = modelInfo.value?.supportsThinking || false
          return shouldShow
        }
        
        // 对于必需参数，只显示特定的几个
        if (param.required) {
          const allowedRequiredParams = ['temperature', 'max_tokens', 'top_p']
          const isAllowed = allowedRequiredParams.includes(param.name)
          return isAllowed
        }
        
        // 对于非必需参数，检查是否在允许列表中，并考虑模型特定参数
        const allowedOptionalParams = ['temperature', 'stream', 'presence_penalty', 'frequency_penalty', 'response_format', 'tool_choice', 'stop', 'logit_bias', 'thinking', 'n', 'max_tokens']
        const isAllowed = allowedOptionalParams.includes(param.name)
        return isAllowed
      })
      
      // 加载用户已保存的参数设置
      const selectedModelsService = SelectedModelsService.getInstance()
      const savedParameters = selectedModelsService.getModelParameters(modelName.value)
      
      // 初始化参数值
      paramValues.value = {}

      parameters.value.forEach(param => {
        if (savedParameters && savedParameters[param.name] !== undefined) {
          // 对于特殊参数，使用正确的值类型
          if (param.name === 'thinking') {
            // thinking参数统一使用布尔值类型
            paramValues.value[param.name] = Boolean(savedParameters[param.name])
          } else if (param.name === 'response_format') {
            if (savedParameters[param.name] && typeof savedParameters[param.name] === 'object') {
              // 将对象转换为标准JSON字符串
              const jsonString = JSON.stringify(savedParameters[param.name])
              paramValues.value[param.name] = jsonString
            } else {
              paramValues.value[param.name] = '{"type":"text"}'
            }
          } else if (param.name === 'tool_choice') {
            paramValues.value[param.name] = savedParameters[param.name] || 'auto'
          } else if (param.type === ParameterType.BOOLEAN) {
            // 确保布尔类型参数的值是布尔值
            paramValues.value[param.name] = Boolean(savedParameters[param.name])
          } else if (param.type === ParameterType.ARRAY || param.type === ParameterType.OBJECT) {
            paramValues.value[param.name] = JSON.stringify(savedParameters[param.name])
          } else {
            paramValues.value[param.name] = savedParameters[param.name]
          }
        } else {
          // 使用默认值
          if (param.name === 'thinking') {
            // thinking参数使用布尔类型，默认为true
            const defaultThinkingValue = true
            paramValues.value[param.name] = param.defaultValue !== undefined ? Boolean(param.defaultValue) : defaultThinkingValue
          } else if (param.name === 'response_format') {
            // response_format参数使用标准JSON字符串
            paramValues.value[param.name] = '{"type":"text"}'
          } else if (param.name === 'tool_choice') {
            paramValues.value[param.name] = 'auto'
          } else if (param.type === ParameterType.BOOLEAN) {
            // 确保布尔类型参数的值是布尔值
            const defaultBooleanValue = param.defaultValue !== undefined ? Boolean(param.defaultValue) : false
            paramValues.value[param.name] = defaultBooleanValue
          } else if (param.type === ParameterType.ARRAY || param.type === ParameterType.OBJECT) {
            // 对于对象类型参数，确保默认值是有效的JSON字符串
            if (param.defaultValue !== undefined && param.defaultValue !== null) {
              // 如果默认值已经是字符串，直接使用
              if (typeof param.defaultValue === 'string') {
                paramValues.value[param.name] = param.defaultValue
              } else {
                // 如果默认值是对象，转换为JSON字符串
                paramValues.value[param.name] = JSON.stringify(param.defaultValue)
              }
            } else {
              paramValues.value[param.name] = JSON.stringify(param.type === ParameterType.ARRAY ? [] : {})
            }
          } else {
            paramValues.value[param.name] = param.defaultValue !== undefined ? param.defaultValue : ''
          }
        }
      })
    }
    
  } catch (error) {
    console.error('加载模型信息失败:', error);
  } finally {
    loading.value = false;
  }
};

const getParameterMin = (param: ModelParameter): number | undefined => {
  // 从描述中提取最小值
  const description = param.description || '';
  
  // 对于max_tokens参数，通常没有明确的最小值限制，除非特别说明
  if (param.name === 'max_tokens') {
    // 只有当明确提到最小值时才设置最小值
    const minMatch = description.match(/最小\s*(\d+)/);
    if (minMatch) {
      return parseInt(minMatch[1], 10);
    }
    // 其他情况返回undefined，允许任意正值
    return undefined;
  }
  
  // 对于其他参数，从描述中提取最小值
  // 匹配格式如 "范围-2.0到2.0" 或 "范围-2.0-2.0"
  const rangeMatch = description.match(/范围(-?\d+(?:\.\d+)?)\s*(?:到|-)/);
  if (rangeMatch) {
    return parseFloat(rangeMatch[1]);
  }
  
  // 匹配格式如 "0-2之间" 或 "0-1之间"
  const rangeMatch2 = description.match(/(\d+(?:\.\d+)?)\s*-\s*\d+(?:\.\d+)?\s*之间/);
  if (rangeMatch2) {
    return parseFloat(rangeMatch2[1]);
  }
  
  // 匹配格式如 "默认1，最大5" - 但要确保不是max_tokens这种特殊情况
  if (param.name !== 'max_tokens') {
    const defaultMaxMatch = description.match(/默认(-?\d+(?:\.\d+)?)\s*，?最大\s*(-?\d+(?:\.\d+)?)/);
    if (defaultMaxMatch) {
      return parseFloat(defaultMaxMatch[1]);
    }
  }
  
  return undefined;
};

const getParameterMax = (param: ModelParameter): number | undefined => {
  // 从描述中提取最大值
  const description = param.description || '';
  
  // 1. 匹配格式如 "范围-2.0到2.0" 或 "范围-2.0-2.0"
  let match = description.match(/范围-?\d+(?:\.\d+)?\s*(?:到|-)(-?\d+(?:\.\d+)?)/);
  if (match) {
    return parseFloat(match[1]);
  }
  
  // 2. 匹配格式如 "默认1，最大5"
  match = description.match(/默认-?\d+(?:\.\d+)?\s*，?最大\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return parseFloat(match[1]);
  }
  
  // 3. 匹配格式如 "最大64K"（数字+K后缀）
  match = description.match(/最大\s*(\d+)K/i);
  if (match) {
    return parseInt(match[1], 10) * 1024;
  }
  
  // 4. 匹配格式如 "最大8,192"（带逗号的数字）
  match = description.match(/最大\s*(\d{1,3}(?:,\d{3})*)/);
  if (match) {
    return parseInt(match[1].replace(/,/g, ''), 10);
  }
  
  // 5. 匹配格式如 "最大8"（纯数字，保持向后兼容）
  match = description.match(/最大\s*(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  
  return undefined;
};

const getParameterStep = (param: ModelParameter): string => {
  // 对于浮点数参数，使用小步长
  if (param.name === 'temperature' || param.name === 'top_p' || 
      param.name === 'presence_penalty' || param.name === 'frequency_penalty') {
    return '0.1';
  }
  // 对于n参数，步长为1
  if (param.name === 'n') {
    return '1';
  }
  return '1';
};

const validateParameter = (param: ModelParameter, value: any): string | null => {
  if (param.type === ParameterType.NUMBER) {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return '请输入有效的数字';
    }
    
    const min = getParameterMin(param);
    const max = getParameterMax(param);
    
    if (min !== undefined && numValue < min) {
      return `值不能小于 ${min}`;
    }
    
    if (max !== undefined && numValue > max) {
      return `值不能大于 ${max}`;
    }
  } else if (param.name === 'response_format') {
    // 验证response_format是否为有效的JSON
    try {
      const parsedValue = JSON.parse(value);
      if (!parsedValue.type) {
        return 'response_format 必须包含 type 属性';
      }
    } catch (e) {
      return '请输入有效的JSON格式';
    }
  } else if (param.name === 'thinking') {
    // thinking参数已经简化为布尔类型，不需要特殊验证
    // 确保值是布尔类型
    return null;
  } else if (param.type === ParameterType.ARRAY || param.type === ParameterType.OBJECT) {
    try {
      JSON.parse(value);
    } catch (e) {
      return '请输入有效的JSON格式';
    }
  }
  
  return null;
};

const validateAllParameters = (): boolean => {
  validationErrors.value = {};
  let isValid = true;
  
  parameters.value.forEach(param => {
    const error = validateParameter(param, paramValues.value[param.name]);
    if (error) {
      validationErrors.value[param.name] = error;
      isValid = false;
    }
  });
  
  return isValid;
};

const saveParameters = () => {
  if (!validateAllParameters()) {
    return;
  }

  try {
    // 准备保存的参数值
    const parametersToSave: { [key: string]: any } = {};

    parameters.value.forEach(param => {
      if (param.name === 'thinking') {
        // thinking参数直接保存为布尔值
        parametersToSave[param.name] = Boolean(paramValues.value[param.name])
      } else if (param.name === 'response_format') {
        // response_format参数解析为对象
        try {
          // 直接解析标准JSON格式
          parametersToSave[param.name] = JSON.parse(paramValues.value[param.name])
        } catch (e) {
          console.error(`解析参数 ${param.name} 失败:`, e)
          parametersToSave[param.name] = { type: "text" }
        }
      } else if (param.name === 'tool_choice') {
        // tool_choice参数直接使用字符串值
        parametersToSave[param.name] = paramValues.value[param.name]
      } else if (param.type === ParameterType.ARRAY || param.type === ParameterType.OBJECT) {
        // 解析JSON字符串
        try {
          parametersToSave[param.name] = JSON.parse(paramValues.value[param.name])
        } catch (e) {
          console.error(`解析参数 ${param.name} 失败:`, e)
          parametersToSave[param.name] = param.defaultValue
        }
      } else {
        parametersToSave[param.name] = paramValues.value[param.name];
      }
    });
    
    // 保存参数设置
    const selectedModelsService = SelectedModelsService.getInstance();
    const settings: ModelParameterSettings = {
      modelName: modelName.value,
      parameters: parametersToSave
    };
    selectedModelsService.saveModelParameterSettings(settings);
    
    // 触发保存事件
    emit('save', modelName.value, parametersToSave);
    closeDialog();
  } catch (error) {
    console.error('保存参数失败:', error);
  }
};

const resetToDefaults = () => {
  // 重置所有参数为默认值
  parameters.value.forEach(param => {
    if (param.name === 'thinking') {
      // thinking参数重置为布尔类型true
      paramValues.value[param.name] = true;
    } else if (param.name === 'response_format') {
      // response_format参数重置为标准JSON格式
      paramValues.value[param.name] = '{"type":"text"}';
    } else if (param.name === 'tool_choice') {
      paramValues.value[param.name] = 'auto'; // 重置为自动选择
    } else if (param.name === 'stream') {
      paramValues.value[param.name] = true; // 重置为启用
    } else if (param.type === ParameterType.ARRAY || param.type === ParameterType.OBJECT) {
      paramValues.value[param.name] = JSON.stringify(param.defaultValue || (param.type === ParameterType.ARRAY ? [] : {}));
    } else {
      paramValues.value[param.name] = param.defaultValue !== undefined ? param.defaultValue : '';
    }
  });
  
  validationErrors.value = {};
};

const closeDialog = () => {
  emit('close');
};

// 监听对话框显示状态
watch(() => isVisible.value, (newIsVisible) => {
  if (newIsVisible && modelName.value) {
    loadModelInfo();
  }
});

// 监听参数值变化，实时验证
watch(() => paramValues.value, (_newValues) => {
  // 清除之前的验证错误
  validationErrors.value = {};
  
  // 验证所有参数
  parameters.value.forEach(param => {
    const error = validateParameter(param, paramValues.value[param.name]);
    if (error) {
      validationErrors.value[param.name] = error;
    }
  });
}, { deep: true });

// 监听stream参数的变化，确保它始终是布尔类型
watch(
  () => paramValues.value['stream'],
  (newValue) => {
    if (typeof newValue === 'string') {
      paramValues.value['stream'] = newValue === 'true';
    }
  },
  { immediate: true }
);

// 组件挂载时加载数据
onMounted(() => {
  if (isVisible.value && modelName.value) {
    loadModelInfo()
  }
});
</script>

<style scoped>
.model-parameter-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.model-parameter-dialog {
  background-color: white;
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
  color: #333;
}

.close-button {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #666;
  padding: 0;
  width: 30px;
  height: 30px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.close-button:hover {
  color: #333;
}

.dialog-content {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.loading, .no-parameters {
  text-align: center;
  padding: 40px 0;
  color: #666;
}

.parameter-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.parameter-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.parameter-row {
  display: flex;
  flex-direction: row;
  gap: 16px;
  align-items: flex-start;
}

.parameter-label {
  font-weight: 500;
  color: #333;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
  max-width: 150px;
  flex-shrink: 0;
}

.parameter-description {
  font-size: 12px;
  color: #666;
  font-weight: normal;
}

.parameter-input {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
}

.input-number, .input-text, .input-select, .input-textarea {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  width: 100%;
  box-sizing: border-box;
}

.input-number:focus, .input-text:focus, .input-select:focus {
  outline: none;
  border-color: #4a90e2;
  box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.2);
}

.input-checkbox-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-checkbox {
  width: 16px;
  height: 16px;
}

.checkbox-label {
  font-size: 14px;
  color: #333;
}

.radio-group {
  display: flex;
  flex-direction: row;
  gap: 16px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.input-radio-group {
  display: flex;
  flex-direction: row;
  gap: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.input-radio {
  width: 16px;
  height: 16px;
}

.radio-text {
  font-size: 14px;
  color: #333;
}

.input-textarea {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  width: 100%;
  font-family: monospace;
  resize: vertical;
}

.input-textarea:focus {
  outline: none;
  border-color: #4a90e2;
  box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.2);
}

.error-message {
  color: #e74c3c;
  font-size: 12px;
  margin-top: 4px;
}

.dialog-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

.action-buttons {
  display: flex;
  gap: 12px;
}

.btn-primary, .btn-secondary {
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  border: none;
}

.btn-primary {
  background-color: #4a90e2;
  color: white;
}

.btn-primary:hover {
  background-color: #357abd;
}

.btn-secondary {
  background-color: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;
}

.btn-secondary:hover {
  background-color: #e9e9e9;
}

/* 固定值提示样式 */
.fixed-value-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #666;
  background-color: #f0f0f0;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 禁用输入框样式 */
input:disabled {
  background-color: #f5f5f5;
  color: #999;
  cursor: not-allowed;
}
</style>