import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'path'

export default defineConfig({
  plugins: [viteSingleFile()],
  server: {
    allowedHosts: ['deggen.ngrok.app'],
  },
  build: {
    outDir: path.resolve(__dirname, '../docs'),
    emptyOutDir: false,
    rollupOptions: {
      input: 'fund.html',
    }
  }
})
