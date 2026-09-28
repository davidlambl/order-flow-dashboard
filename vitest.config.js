// vitest.config.js — test runner only; vite.config.js keeps the dev proxy and the Tailwind plugin.
import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'forks', // runtime process.env.TZ changes (calendar/charts tests) need a real process
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // A developer's .env sets VITE_SUPABASE_*; tests must never build the default client (src/lib/supabase.js).
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx,ts,tsx}', 'netlify/functions/**/*.{js,ts}', 'shared/**/*.{js,ts}'],
      exclude: ['src/main.{jsx,tsx}', 'src/assets/**', 'src/test/**', 'netlify/functions/__tests__/**', '**/*.test.{js,jsx,ts,tsx}', '**/*.d.ts', 'types/**'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['netlify/**/*.test.{js,ts}', 'shared/**/*.test.{js,ts}', 'src/**/*.node.test.{js,ts}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.{js,jsx,ts,tsx}'],
          exclude: [...configDefaults.exclude, '**/*.node.test.{js,ts}'], // a project's exclude replaces the defaults
          setupFiles: ['src/test/setup.js'],
        },
      },
    ],
  },
});
