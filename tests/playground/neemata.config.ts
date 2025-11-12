import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'nmtjs/config'

export default defineConfig({ build: { minify: false }, plugins: [vue()] })
