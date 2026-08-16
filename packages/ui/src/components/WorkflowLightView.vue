<template>
  <!-- workflow 轻量态：同一组件的惰性配置（非第二实现）——toolbar 隐藏 + 迭代 5 只读封堵清单全量生效 -->
  <WorkflowView ref="innerRef" :readonly="true" :light="true" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import WorkflowView from '../views/WorkflowView.vue'

const innerRef = ref<InstanceType<typeof WorkflowView>>()

// 透传编辑器命令式接口（Home「设置 → 打开工作流」经 dock.waitActiveEditor 调用 openWorkflow；轻量态同样可加载）
defineExpose({
  openWorkflow: (id: string) => (innerRef.value as any)?.openWorkflow?.(id)
})
</script>
