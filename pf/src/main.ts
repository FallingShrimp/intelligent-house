import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { pbClient } from './ws/client'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

// 启动 PB WebSocket 连接（须在 pinia 安装后，回调内才可获取 store）
pbClient.connect()
