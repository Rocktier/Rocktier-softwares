# Pic2WebP 构建指南

## macOS

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建 + ad-hoc 签名（推荐发布）
npm run build:release

# 仅构建，不签名
npm run tauri build
```

构建产物: `src-tauri/target/release/bundle/dmg/Pic2WebP_<version>_aarch64.dmg`

### x86_64 构建需要 nasm（AVIF 输出引入，2026-11-25）

AVIF 走 `ravif` → `rav1e`，而 rav1e 在 **x86_64** 上用汇编优化，构建脚本找不到
`nasm` 会直接 panic（`NASM build failed. Make sure you have nasm installed or
disable the "asm" feature.`，退出码 101，报错只在 build script 的 stderr 里，
很容易被当成随机失败）。arm64 不需要。

```bash
brew install nasm          # Intel Mac，或 universal 交叉编译（x86_64-apple-darwin）
```

CI 已在这三条腿上装好：`pic2webp-build.yml` 的 x64 腿、`pic2webp-mas-package.yml`
（universal 交叉编译）、`pic2webp-bench.yml`（Intel runner）。

### 签名说明

**CI 发版（唯一可信路径）**：`.github/workflows/pic2webp-build.yml` 从 secret 导入
`APPLE_CERT_P12`，拿到 `Developer ID Application: Lei Dang (7384875SK5)`，重签 `.app`
并重打 DMG，然后交给 `scripts/notarize-dmg.sh`——它优先用 App Store Connect API Key
（`APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`，不过期）提交公证并 staple，
Apple ID + 专用密码只作回退。判据是产物出现 `source=Notarized Developer ID`，由工作流里的
`spctl` 硬断言把关。六个 secret 已灌在 `Rocktier/Rocktier-softwares`。

**本地构建**：`npm run build:release` 仍是 ad-hoc 签名（本机没有证书私钥），
只能自测，别发给用户——Gatekeeper 会拦。

## Windows

```powershell
cd pic2webp
npm install
npm run tauri build
```

WebP 编码已内置（libwebp 静态链接），无需下载 cwebp.exe。
构建产物: `src-tauri/target/release/bundle/nsis/Pic2WebP_<version>_x64-setup.exe`
