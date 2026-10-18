/// <reference types="vite/client" />

/** 环境变量声明（.env 文件中配置，Vite 仅暴露 VITE_ 前缀变量） */
interface ImportMetaEnv {
  /** PB 仿真状态层 WebSocket 地址，如 ws://192.168.1.10:3000/ws/pf */
  readonly VITE_PB_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
