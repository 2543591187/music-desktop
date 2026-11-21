/* ESLint 门禁（#4，2026-11-21）：npm run lint
   只 lint 主进程/预加载 CommonJS 文件（index.html 内联脚本不在此列）。
   基线规则：未定义变量 / 未使用变量 / 重复键 / 不可达代码 —— 全为 error。 */
import globals from "globals";

export default [
  {
    files: ["main.js", "preload.js", "mini-preload.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none" }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
    },
  },
];
