import { defineConfig } from 'vite';
export default defineConfig({ root: 'web', base: '/', build: { outDir: '../dist', emptyOutDir: true,rolldownOptions:{input:{main:'web/index.html',legacy:'web/legacy.html',preview:'web/app-preview.html'}} } });
