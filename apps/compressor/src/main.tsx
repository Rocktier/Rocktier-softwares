import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

/*
 * 真材质分档（Lenso 阶段 265，阶段 267 改为构建期定档）。
 *
 * 只有 macOS 的窗口是透明的（tauri.macos.conf.json 里 transparent + windowEffects），
 * 桌面光透进来之后，柔光底才该从「冒充壁纸」降级成品牌 tint。Windows/Linux 没有
 * 对应材质，窗口保持不透明，走原来的柔光底 —— 同一个前端源码，靠这个属性分开。
 *
 * 为什么不再嗅探 UA：上一版判 `navigator.userAgent` 含 Macintosh。判对了也一样要
 * 等到模块执行才能定档（首帧前的时序问题），判错了则是**静默**退回不透明 ——
 * 用户看到「材质没开」，控制台里一个字都没有，本轮就是这么卡住的。
 * 现在由 vite 的 define 在构建期注入常量：macOS 包恒为 "vibrancy"，Windows 包恒为 ""，
 * 不存在运行期判错的余地。
 */
declare const __MATERIAL__: string;

if (__MATERIAL__) {
  document.documentElement.dataset.material = __MATERIAL__;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
