/**
 * ESLint 配置（ESLint 8 eslintrc 格式）
 *
 * 本仓库此前没有任何 lint 配置，根 `lint` 脚本必然报
 * "No ESLint configuration found"，CI 里也没有 lint 环节。
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true, worker: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    '**/dist/**',
    '**/node_modules/**',
    '**/.wrangler/**',
    '**/coverage/**',
    '**/*.d.ts',
    '**/*.js',
  ],
  rules: {
    // TypeScript 已经负责未定义标识符检查，eslint 的 no-undef 会对类型与全局误报
    'no-undef': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // 允许显式 any，但提示出来，避免悄悄扩散
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn',
    // Hooks 调用规则是硬错误；依赖数组问题（多为轮询/副作用的有意省略）先作为告警暴露，
    // 不阻断 lint 门禁，但会进入 CI 日志以便逐个收敛。
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
