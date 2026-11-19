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
              // entriesAware 会按「哪些路由用到」把 antd 拆成多个 chunk。
              // 但 Knowledge / Agent 同时出现在两组里，共享模块会被复制到两个
              // chunk 并互相 import，形成**循环 chunk 依赖**：
              //   vendor-antd~SeedStore~...  调用了
              //   vendor-antd~Drawings~...  导出的一个**对象**（本该是函数）
              // → 运行时报 "ne is not a function"，/drawings /translate /literature 整页白屏。
              // 合并成单一 antd chunk 是最稳的解法：体积换正确性。
              name: 'vendor-antd',
              test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+)[\\/]/,
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
