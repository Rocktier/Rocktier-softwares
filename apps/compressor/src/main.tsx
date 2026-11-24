import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

/*
 * 真材质分档（Lenso 阶段 265）。
 *
 * 只有 macOS 的窗口是透明的（tauri.macos.conf.json 里 transparent + windowEffects），
 * 桌面光透进来之后，柔光底才该从「冒充壁纸」降级成品牌 tint。Windows/Linux 没有
 * 对应材质，窗口保持不透明，走原来的柔光底 —— 同一个前端 bundle，靠这个属性分开。
 *
 * 为什么用 UA 而不是 Tauri API：这一步必须在**首帧之前**同步完成，否则会闪一下
 * 实底。plugin-os 是异步的，装在 Linux/Windows 上还要多一个平台查询权限；
 * 而这里要判的本来就是一个平台事实，UA 在这个场景下是准确的（WKWebView 必带
 * Macintosh）。CSP 是 script-src 'self'，所以只能放在模块里，不能写内联 script。
 */
if (/Macintosh/.test(navigator.userAgent)) {
  document.documentElement.dataset.material = "vibrancy";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
