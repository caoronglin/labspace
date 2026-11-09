import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 首屏入口 gzip 约 418 KB（antd 按路由拆分后），阈值留出余量防止误报。
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        // Rolldown（Vite 8）按「哪些入口真正用到」拆分第三方库：
        // 首屏只下载 index 实际引用的 antd 模块，路由页面的组件各自按需加载。
        codeSplitting: {
          groups: [
            { name: 'vendor-charts', test: /node_modules[\\/](@ant-design[\\/]plots|@antv)/, entriesAware: true },
            {
              name: 'vendor-antd',
              test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+)[\\/]/,
              entriesAware: true,
              entriesAwareMergeThreshold: 40000,
            },
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, entriesAware: true },
            { name: 'vendor-query', test: /node_modules[\\/]@tanstack/, entriesAware: true },
            { name: 'vendor', test: /node_modules/, entriesAware: true, minSize: 40000 },
          ],
        },
      },
    },
  },
});
