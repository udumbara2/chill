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
