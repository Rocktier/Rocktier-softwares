#!/usr/bin/env bash
# 公证一个已经用 Developer ID 签过名的 DMG，然后 staple 票据。
#
# 为什么要有这个脚本：8 个应用各自的工作流里都抄了一份 notarytool 调用，认证方式写死成
# Apple ID + App 专用密码。App 专用密码要在 appleid.apple.com 用 2FA 现场生成、90 天会失效、
# 换机器还得重来；而 App Store Connect API Key 用现成的 .p8，不过期，也不需要 2FA。
# 抄六份就会六份一起错，所以认证判断收敛到这一处。
#
# 认证优先级（谁在就用谁）：
#   1. APPLE_API_KEY_P8 + APPLE_API_KEY_ID + APPLE_API_ISSUER  → --key / --key-id / --issuer
#   2. APPLE_ID + APPLE_APP_PASSWORD (+ APPLE_TEAM_ID)         → --apple-id / --password / --team-id
#   3. 都没有 → 退出码 3（调用方当作「跳过公证」处理，不算失败）
#      但若此时 APPLE_CERT_P12 存在，说明「证书配了、凭据没配」——这是配置错误，
#      退出码 4。否则产物是 Unnotarized Developer ID，Gatekeeper 必拒，而调用方的
#      「有证书就断言 Gatekeeper 必须接受」会报出一句和根因无关的 rejected（2026-11-23
#      write-build 就红在这里：实际是漏传 APPLE_API_* 三个 secret）。
#
# 用法：bash scripts/notarize-dmg.sh path/to/Rocktier.Foo_1.0.0_aarch64.dmg
# 退出码：0 成功 / 3 无凭据跳过（未配证书时合法）/ 4 配了证书但没凭据（配置错误）
#         其他 notarytool 或 stapler 的失败码

set -uo pipefail

dmg="${1:-}"
[ -n "$dmg" ] || { echo "用法: notarize-dmg.sh <dmg>" >&2; exit 64; }
[ -f "$dmg" ] || { echo "文件不存在: $dmg" >&2; exit 64; }

auth=()
kind=""

if [ -n "${APPLE_API_KEY_P8:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  key_dir="${RUNNER_TEMP:-$(mktemp -d)}"
  key="$key_dir/AuthKey_${APPLE_API_KEY_ID}.p8"
  printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$key"
  chmod 600 "$key"
  auth=(--key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  kind="api-key ${APPLE_API_KEY_ID}"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
  kind="apple-id ${APPLE_ID}"
else
  if [ -n "${APPLE_CERT_P12:-}" ]; then
    echo "::error::APPLE_CERT_P12 已配置，但没有任何公证凭据（APPLE_API_KEY_P8/ID/ISSUER 或 APPLE_ID/APPLE_APP_PASSWORD）。这会让产物变成 Unnotarized Developer ID，Gatekeeper 必然拒绝。请把公证凭据一并传进这个步骤的 env。" >&2
    exit 4
  fi
  echo "::warning::没有任何公证凭据（APPLE_API_* 或 APPLE_ID/APPLE_APP_PASSWORD），跳过公证。签名已生效，但下载后 Gatekeeper 仍会拦一次。" >&2
  exit 3
fi

echo "notarizing $(basename "$dmg") as $kind"
xcrun notarytool submit "$dmg" "${auth[@]}" --wait || exit $?
xcrun stapler staple "$dmg" || exit $?
xcrun stapler validate "$dmg" || exit $?
