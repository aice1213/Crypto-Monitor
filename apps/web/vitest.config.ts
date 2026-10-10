import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只测纯逻辑（lib/*.ts），不引入 jsdom / Testing Library
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
