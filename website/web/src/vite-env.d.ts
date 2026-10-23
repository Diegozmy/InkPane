/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 前缀。开发期默认为 /api（由 Vite 代理转发）；部署时可指向独立域名。 */
  readonly VITE_API_BASE?: string;
  /** 设备端拉取屏幕数据的地址（用于展示与复制）；留空则使用当前页面 origin。 */
  readonly VITE_DEVICE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
