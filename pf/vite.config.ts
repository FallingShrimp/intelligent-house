import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// PB 本机地址（dev/preview 服务把 /ws、/api 代理到该地址，穿透场景仅需映射前端端口）
const PB_TARGET = 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // 外网穿透场景：允许任意域名访问；WS/HTTP 经前端端口代理到本机 PB（单端口复用）
  preview: {
    allowedHosts: true,
    proxy: {
      '/ws/pf': { target: PB_TARGET, ws: true },
      '/ws/scb': { target: PB_TARGET, ws: true },
      '/api': { target: PB_TARGET },
    },
  },
  server: {
    proxy: {
      '/ws/pf': { target: PB_TARGET, ws: true },
      '/ws/scb': { target: PB_TARGET, ws: true },
      '/api': { target: PB_TARGET },
    },
  },
})
