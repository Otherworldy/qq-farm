import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    typescript: true,
    stylistic: false,
    yaml: false,
    jsonc: false,
    markdown: false,
    formatters: false,
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      'no-console': 'off',
      'no-use-before-define': 'off',
      'perfectionist/sort-imports': 'off',
      'ts/consistent-type-definitions': 'off',
      'ts/consistent-type-imports': 'off',
      'ts/no-explicit-any': 'off',
      'ts/no-require-imports': 'off',
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/process': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-node-protocol': 'off',
    },
  },
  {
    // 归档目录保存退役代码原样（奶茶热销中 S4），不参与构建也不应被现行
    // 代码风格约束回溯修改；恢复时再随恢复一并整治。
    ignores: ['archive/**'],
  },
)
