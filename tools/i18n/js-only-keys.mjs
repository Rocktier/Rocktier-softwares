/* 只被 JS 使用、不出现在任何 HTML data-i18n 里的键。
 *
 * 为什么需要单独一份名单：这几个键是**控件名称**（导航 / 移动导航 / 主题 /
 * 存储声明 / 语言 / 菜单按钮），写进 aria-label 属性而不是元素文本，
 * 所以抽取器（从 HTML 元素内容取源）永远看不到它们。两处依赖这份名单：
 *
 *   gen-site-i18n.mjs  要把它们合进 i18n/zh.json —— 生成器只映射英文基线里的键，
 *                      不合并的话运行时 dict 里没有它们，labelControls() 会静默
 *                      回退英文，中文站读屏器听到的就是英文名称。
 *   check-site.mjs     孤儿键判据只认 HTML 里的 data-i18n 引用，不豁免的话
 *                      每次运行都多 6 条永远不该修的警告。
 *
 * 分两处手写必然漂移（本仓已漏过两次），所以放一份、两边 import。
 * 行为本身由 ux 的 C32 断言覆盖（切语言后读 DOM 名称），不靠闸门兜。 */
export const JS_ONLY_KEYS = [
  "nav.menu",
  "ui.nav",
  "ui.mobileNav",
  "ui.theme",
  "ui.consent",
  "ui.language",
  "ui.dl",
];
