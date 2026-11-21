# e2e/ — 浏览器与接口体检脚本

这里放两类东西，规则只有一条：**留在仓库里的脚本必须有人跑**。

## 命名与保留规则

| 前缀 | 含义 | 是否进回归套件 |
| --- | --- | --- |
| `<name>.mjs`（无下划线） | 正式用例 | **必须**列进 `run-regression.sh` 的 `ALL` 数组 |
| `_<name>.mjs` | 一次性的现场探针（复现某个具体 bug、临时看某个响应） | 不进套件；必须被 `docs/` 或注释引用，否则删 |

判断标准（也是 2026-11 那次收敛的依据）：

1. 在 `run-regression.sh` 里 → 留下，且每次都跑；
2. 被 `docs/` 或 `README` 当作复现步骤引用 → 留下（`_` 前缀，人工执行）；
3. 两者都不是 → 删掉。历史在 git 里，需要时 `git log -- e2e/` 捞回来。

那次清理删掉了 161 个 `_*.mjs` 与 3 个过期脚本（`quantum-real-flow`、`devtools-test`、
`q-oidc-ip`：Quantum 已下线、后两个与 `oidc-ip-flow` 重复），同时把 12 个一直手工
执行、却没进 `ALL` 的脚本补进回归——有套件但没被套件覆盖，等于没有护栏。

## 跑法

```bash
# 全量（需要测试账号口令）
LAB_PASS=<student01 口令> LAB_ADMIN_PASS=<labadmin 口令> ./run-regression.sh

# 只跑某几个
LAB_PASS=… LAB_ADMIN_PASS=… ./run-regression.sh api-integration.mjs e2e.mjs
```

口令从部署机的 `/etc/labspace/casdoor-users.txt` 取（0600，不入库）。
脚本默认连 `http://192.0.2.10`（双入口里的 LAN 地址），Tailscale 侧用
`tailscale-access-test.mjs` 单独验。

## 单个探针怎么写

```js
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://192.0.2.10';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await (await b.newContext({ locale: 'zh-CN' })).newPage();
// …断言：失败要 `process.exit(1)`，别只 console.log
await b.close();
```

约定：

- `BASE` 走环境变量，不要把地址写死在脚本里（换入口要能跑）；
- 失败必须非零退出，否则套件里永远是绿的；
- 每个脚本控制在能跑完 7 分钟内（`run-regression.sh` 用 `timeout 420` 兜底）。
