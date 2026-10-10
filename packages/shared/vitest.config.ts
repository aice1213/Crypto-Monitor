import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑源码测试，避免把 tsc 产物 dist/*.test.js 也当成测试
    include: ['src/**/*.test.ts'],
  },
});
