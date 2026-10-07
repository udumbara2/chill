<template>
  <!-- workflow 轻量态：同一组件的惰性配置（非第二实现）——toolbar 隐藏 + 迭代 5 只读封堵清单全量生效 -->
  <WorkflowView :readonly="true" :light="true" />
</template>

<script setup lang="ts">
import WorkflowView from '../views/WorkflowView.vue'
</script>
