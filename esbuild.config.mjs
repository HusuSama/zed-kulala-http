// esbuild 打包配置：将 ls/server.ts 及其依赖打包成单文件 CommonJS 产物，
// 供 `node dist/cli.cjs --stdio` 运行，作为 Zed 的 language server 进程。
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, "ls/server.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: join(root, "dist/cli.cjs"),
  sourcemap: true,
  // 中继服务仅使用 Node 内置模块与全局 fetch，无外部运行时依赖，
  // 因此可以让 esbuild 把所有代码（含动态 import 的 Node 模块）打进去。
  packages: "external",
  banner: {
    // CommonJS 入口需要识别 `#!/usr/bin/env node` 与直接运行场景。
    js: "#!/usr/bin/env node",
  },
  logLevel: "info",
});
