import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { pbClient } from './ws/client'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

// 启动 PB WebSocket 连接（须在 pinia 安装后，回调内才可获取 store）。
// 联机对战：已保存 DisplayName 才立即连接；首次连接由 App.vue 的
// 名字输入对话框确认后再连接（PB 要求 hello 必须携带 display_name）。
const savedName = localStorage.getItem('DisplayName')
if (savedName && savedName.trim()) {
  pbClient.setDisplayName(savedName.trim())
  pbClient.connect()
}
