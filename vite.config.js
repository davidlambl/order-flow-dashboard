import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    // ANALYZE=1 npm run build writes dist/stats.html, a treemap of the bundle
    process.env.ANALYZE ? visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true }) : null,
  ].filter(Boolean),
  build: {
    manifest: true, // dist/.vite/manifest.json: every chunk's static and dynamic imports, for the bundle budget check
    rolldownOptions: {
      output: {
        // Vendor chunks stay cached across deploys that change only the app, and the charting and markdown libraries
        // get files that only the sections loaded on demand import. A group also takes what its modules import unless
        // a higher-priority group has it, so React and the entry's libraries claim first: a module the entry shares
        // with a lazy library must never land in that library's chunk, or the whole chunk loads at startup.
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
            { name: 'query', test: /[\\/]node_modules[\\/]@tanstack[\\/]/, priority: 2 },
            { name: 'supabase', test: /[\\/]node_modules[\\/]@supabase[\\/]/, priority: 2 },
            { name: 'recharts', test: /[\\/]node_modules[\\/]recharts[\\/]/, priority: 1 },
            { name: 'markdown', test: /[\\/]node_modules[\\/](react-markdown|remark-gfm)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/.netlify/functions': {
        target: 'http://localhost:8888',
        changeOrigin: true,
      },
    },
  },
})
