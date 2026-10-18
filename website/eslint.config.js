import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 精简但有效的 ESLint 配置。
 *
 * 刻意只开启真正有价值、且不会与 tsc 重复的规则：
 *  - react-hooks/rules-of-hooks 是 error：Hook 顺序错误会导致整页崩溃，
 *    类型检查发现不了，必须由 lint 拦住。
 *  - react-hooks/exhaustive-deps 是 warn：提示缺失的依赖，但不阻塞提交。
 *  - no-unused-vars 与 tsc 的 noUnusedLocals 对齐。
 * 其余风格问题交给 Prettier，避免两套工具互相打架。
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'data/**'] },
  {
    // 构建脚本与配置文件运行在 Node 环境
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['server/src/**/*.ts', 'server/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
