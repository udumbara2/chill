import tseslint from 'typescript-eslint'
import erasableSyntaxOnly from 'eslint-plugin-erasable-syntax-only'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'vue' },
          { name: 'vue-router' },
          { name: 'pinia' },
          { name: 'electron' },
          { name: '@tiptap/starter-kit' },
          { name: '@tiptap/vue-3' },
          { name: '@tiptap/core' },
        ],
      }],
    },
  },
  {
    // relay 模块（M2）局部约束：renderer/RN 搬运前提 = erasable 语法（禁 enum/namespace/参数属性）
    files: ['src/services/relay/**/*.ts'],
    plugins: { 'erasable-syntax-only': erasableSyntaxOnly },
    rules: {
      'erasable-syntax-only/enums': 'error',
      'erasable-syntax-only/namespaces': 'error',
      'erasable-syntax-only/parameter-properties': 'error',
      'erasable-syntax-only/import-aliases': 'error',
    },
  },
)
