import tseslint from 'typescript-eslint'

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
)
