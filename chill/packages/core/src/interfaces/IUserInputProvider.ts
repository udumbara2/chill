export interface AskUserOption {
  label: string
  description: string
}

export interface IUserInputProvider {
  /**
   * @param freeTextHint 允许自由文本时展示的提示文案（语境相关，由提问方携带，
   * 如规划审批传"继续修改规划，输入你的想法"）；缺省时呈现层用通用文案
   */
  ask(question: string, options?: AskUserOption[], allowFreeText?: boolean, freeTextHint?: string, attribution?: { sessionId?: string; taskId?: string; itemId?: string }): Promise<string>
}
