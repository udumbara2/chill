import type { ModelInfo } from './models/types'
import { ModelInfoService } from './models/modelInfoService'
import type { IKeyValueStore } from '../interfaces/IKeyValueStore'

export interface ModelParameterSettings {
  modelName: string
  parameters: {
    [parameterName: string]: any
  }
}

export class SelectedModelsService {
  private static instance: SelectedModelsService
  private readonly STORAGE_KEY = 'selected-models'
  private readonly PARAMETERS_KEY = 'model-parameters'
  private readonly CURRENT_MODEL_KEY = 'current-model-name'
  private _store: IKeyValueStore | null = null

  private constructor() {}

  public static getInstance(): SelectedModelsService {
    if (!SelectedModelsService.instance) {
      SelectedModelsService.instance = new SelectedModelsService()
    }
    return SelectedModelsService.instance
  }

  public static setDefaultStore(store: IKeyValueStore): void {
    SelectedModelsService.getInstance()._store = store
  }

  private getStore(): IKeyValueStore {
    if (!this._store) {
      throw new Error('SelectedModelsService is not initialized. Call setDefaultStore() first.')
    }
    return this._store
  }

  public saveSelectedModels(models: ModelInfo[]): void {
    try {
      const modelNames = models.map(model => model.name)
      this.getStore().setItem(this.STORAGE_KEY, JSON.stringify(modelNames))
    } catch (error) {
      console.error('保存已选择模型失败:', error)
    }
  }

  private getSelectedModelNames(): string[] {
    try {
      const stored = this.getStore().getItem(this.STORAGE_KEY)
      if (!stored) return []
      return JSON.parse(stored) as string[]
    } catch (error) {
      console.error('获取已选择模型失败:', error)
      return []
    }
  }

  public getSelectedModels(): ModelInfo[] {
    try {
      const modelInfoService = ModelInfoService.getInstance()
      const selectedNames = this.getSelectedModelNames()
      return modelInfoService.getModelsByNames(selectedNames)
    } catch (error) {
      console.error('获取已选择模型失败:', error)
      return []
    }
  }

  public isModelSelected(modelName: string): boolean {
    const selectedNames = this.getSelectedModelNames()
    return selectedNames.includes(modelName)
  }

  public addSelectedModel(model: ModelInfo): void {
    const selectedModels = this.getSelectedModels()
    const exists = selectedModels.some(m => m.name === model.name)
    
    if (!exists) {
      selectedModels.push(model)
      this.saveSelectedModels(selectedModels)
    }
  }

  public removeSelectedModel(modelName: string): void {
    const selectedModels = this.getSelectedModels()
    const filteredModels = selectedModels.filter(m => m.name !== modelName)
    this.saveSelectedModels(filteredModels)
  }

  public clearSelectedModels(): void {
    try {
      this.getStore().removeItem(this.STORAGE_KEY)
    } catch (error) {
      console.error('清空已选择模型失败:', error)
    }
  }

  public saveModelParameterSettings(settings: ModelParameterSettings): void {
    try {
      const allSettings = this.getAllModelParameterSettings()
      const existingIndex = allSettings.findIndex(s => s.modelName === settings.modelName)
      
      if (existingIndex >= 0) {
        allSettings[existingIndex] = settings
      } else {
        allSettings.push(settings)
      }
      
      this.getStore().setItem(this.PARAMETERS_KEY, JSON.stringify(allSettings))
    } catch (error) {
      console.error('保存模型参数设置失败:', error)
    }
  }

  private getAllModelParameterSettings(): ModelParameterSettings[] {
    try {
      const stored = this.getStore().getItem(this.PARAMETERS_KEY)
      if (!stored) return []
      return JSON.parse(stored) as ModelParameterSettings[]
    } catch (error) {
      console.error('获取模型参数设置失败:', error)
      return []
    }
  }

  public getModelParameterSettings(modelName: string): ModelParameterSettings | null {
    try {
      const allSettings = this.getAllModelParameterSettings()
      return allSettings.find(s => s.modelName === modelName) || null
    } catch (error) {
      console.error('获取模型参数设置失败:', error)
      return null
    }
  }

  public getModelParameters(modelName: string): { [parameterName: string]: any } | null {
    const settings = this.getModelParameterSettings(modelName)
    return settings ? settings.parameters : null
  }

  public removeModelParameterSettings(modelName: string): void {
    try {
      const allSettings = this.getAllModelParameterSettings()
      const filteredSettings = allSettings.filter(s => s.modelName !== modelName)
      this.getStore().setItem(this.PARAMETERS_KEY, JSON.stringify(filteredSettings))
    } catch (error) {
      console.error('删除模型参数设置失败:', error)
    }
  }

  public clearAllModelParameterSettings(): void {
    try {
      this.getStore().removeItem(this.PARAMETERS_KEY)
    } catch (error) {
      console.error('清空模型参数设置失败:', error)
    }
  }

  public saveCurrentModelName(modelName: string): void {
    try {
      this.getStore().setItem(this.CURRENT_MODEL_KEY, modelName)
      // 指针即入列（2026-10-14 跨壳断链根治）：CLI 侧（首启向导 / /model switch）只写指针、
      // 从不写 selected-models；而 UI 聊天下拉列表内容独占读 selected-models——TUI 配好模型
      // 后打开桌面/Web UI，列表恒空、挂载自动恢复被 availableModels.some() 条件卡死（实测：
      // 必须去设置页手动启用模型才出现在列表）。收口：写指针时查卡成功则入列
      // （addSelectedModel 幂等，UI 切换器路径模型必已在列、零副作用）；卡查不到（异常态）
      // 只写指针，行为不劣于旧版。
      try {
        const card = ModelInfoService.getInstance().getModelInfoByName(modelName)
        if (card) this.addSelectedModel(card)
      } catch { /* 模型目录不可用：只写指针（旧版行为） */ }
    } catch (error) {
      console.error('保存当前模型失败:', error)
    }
  }

  public getCurrentModelName(): string | null {
    try {
      return this.getStore().getItem(this.CURRENT_MODEL_KEY)
    } catch (error) {
      console.error('获取当前模型失败:', error)
      return null
    }
  }

  public getCurrentModel(): ModelInfo | null {
    const modelName = this.getCurrentModelName()
    if (!modelName) return null
    
    const modelInfoService = ModelInfoService.getInstance()
    const model = modelInfoService.getModelInfoByName(modelName)
    return model || null
  }

  public clearCurrentModel(): void {
    try {
      this.getStore().removeItem(this.CURRENT_MODEL_KEY)
    } catch (error) {
      console.error('清除当前模型失败:', error)
    }
  }
}
