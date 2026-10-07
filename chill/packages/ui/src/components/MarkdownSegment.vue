<template>
  <div v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getMarkdownRenderer } from '../utils/markdownRenderer'

/**
 * 单个 markdown 块的渲染组件（渲染架构 L4）。
 * 闭合块的 content 永不变 → props 相等 → 组件更新被跳过（md.render 整轮只跑一次）；
 * 只有流式尾块会带着增长中的 content 重渲染（O(尾块+新增)）。
 */
const props = defineProps<{ content: string }>()

const html = computed(() => getMarkdownRenderer().render(props.content))
</script>
