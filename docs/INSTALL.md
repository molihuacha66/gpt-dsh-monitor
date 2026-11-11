# 安装与双端接入

先检查 Node 24.12+。所有命令在解压目录执行，数据保留在指定 home。路径有空格或中文时使用引号。不要把同一实例同时用于多个 DSH 轮询者；第一版每实例一个协作、一个明确目标会话。需要并行的独立协作请使用不同 home、桥端口和 Dashboard 端口。

## 1. 选择一种来源

已有桥：

```powershell
node bin/bridge-between.mjs setup --project 'D:\Projects\MyProject' --source 'D:\ExistingBridge\data\bridge.sqlite' --sessions 'C:\Users\Example\.dsh\sessions'
node bin/bridge-between.mjs start --background
```

新建本套件的桥：

```powershell
node bin/bridge-between.mjs setup --project 'D:\Projects\MyProject' --sessions 'C:\Users\Example\.dsh\sessions'
node bin/bridge-between.mjs start --bridge --background
```

示例路径由使用者替换。未指定 sessions 时只扫描新建的空目录，不自动发现和读取整机 DSH 日志。首次 setup 已存在时保留原设置；更换项目或来源用新的 home/监控库，避免破坏来源绑定。端口冲突用新实例 setup 的 `--port` / `--bridge-port` 设置；不会停止占用者。

setup会探测默认端口并在最多64个候选内避让，输出选定端口；显式端口占用返回PORT_IN_USE。探测与真正启动之间仍可能被其他程序占用，start会安全失败。home必须是专用数据子目录，不能直接使用用户目录根部或卷根。PowerShell变量名请使用任务专用名称，避免HOME等系统变量。

## 2. Codex 侧安装

```powershell
node bin/bridge-between.mjs generate-codex
node bin/bridge-between.mjs install-codex --codex 'C:\Path\To\codex.exe'
```

安装器在数据目录下生成 marketplace 与本机 portable/legacy MCP 配置，通过官方 CLI 安装 `gpt-dsh-monitor@fish-dragon`。显式提供已核对的 Codex 可执行文件路径。对于已配置的自定义 home，每次命令加 `--home 'D:\BridgeBetweenData'`。

兼容安装默认将portable清单保留为模板，使用`.codex-plugin/plugin.json`作为入口，以适配当前验证的客户端。已确认支持portable入口的其他版本可在generate-codex/install-codex上显式加`--portable`。公共源目录保留标准plugin.json；安装器只调整生成的安装源，不编辑客户端缓存。当前本机在隔离CODEX_HOME的官方CLI安装、parser和MCP工具发现已通过，新用户真实界面仍需验收。

同时配置可选通信桥 MCP：

```powershell
node bin/bridge-between.mjs install-codex --codex 'C:\Path\To\codex.exe' --bridge
```

这会额外安装 `dsh-codex-bridge@fish-dragon`，它包含发送/任务工具；只读 monitor 仍是独立 server。安装器不修改 Codex 缓存文件。缓存占用或安装失败会返回 `CODEX_INSTALL_FAILED`，请检查客户端状态后重试，不自动递增版本或清理缓存。

--bridge用于本套件管理的新桥，不适用于合成演示或仅导入外部历史库的配置；后两者返回MANAGED_BRIDGE_REQUIRED。已有外部桥的用户沿用原先的通信连接，另装只读monitor，不根据source路径自动读取外部桥凭据。

安装后在客户端打开桥间并核对资源版本，实际查看消息、文件、健康心跳和持续刷新。旧会话可能仍持有旧工具；按客户端支持的方式重新加载后复查。MCP工具发现成功不等于界面验收通过。网页和远程客户端不能直接读取本机 stdio，本版不提供公网端点。

## 3. DSH 侧原生插件

发布包提供 `components/dsh-plugin`，名称 `@local/dsh-codex-bridge`。它是 Cordis bundle，不是 Codex 插件格式。请在实际使用的 DSH profile 中合并以下内容，保留现有 dependencies 和 bundles：

```json
{
  "dependencies": {"@local/dsh-codex-bridge": "link:D:/YourRelease/components/dsh-plugin"},
  "dsh": {"profile": {"bundles": ["@local/dsh-codex-bridge"]}}
}
```

这是基于已使用 profile 的挂载形状；具体 profile 路径、依赖安装和重载方式以使用者的 DSH 版本为准，本安装器没有自动编辑真实 profile。该路径须指向持续存在的发布目录。真实新 profile 安装仍是本预览的待验收项。

DSH 进程需要的环境变量：

```powershell
$env:DSH_CODEX_BRIDGE_HOME = Join-Path $env:LOCALAPPDATA 'BridgeBetween\bridge'
$env:DSH_CODEX_COLLAB = 'default'
```

从拥有这些变量的环境启动 DSH，原生插件读取共享桥的 endpoint 和自己的身份 token。桥由上面的套件 start --bridge 管理；DSH适配默认只连接它，不另起一份桥。自定义 home 时相应修改 BRIDGE_HOME。

## 4. 自动执行与 followup

默认桥 `wakeEnabled=false`、`autoWakeOnMessages=false`、`codexApproveForMe=false`，DSH 自动 followup 关闭。发送和查询工具仍可使用，自动执行需要使用者单独配置。

需要自动 DSH followup 时，使用与本发布版匹配、health 标记 `manual_poll_cursor` 的桥，给 DSH 进程设置 `DSH_CODEX_AUTO_FOLLOWUP=1` 和 `DSH_CODEX_TARGET_AGENT=<明确会话ID>`。插件优先固定目标，未指定时只使用实际调用过工具的目标，不猜最近窗口；没有目标、投递失败或处于冷却期时不提交游标。该能力由合成宿主测试覆盖，真实 DSH 多窗口/重载仍需验收。

需要 DSH→Codex 自动执行时，在用户数据目录 `bridge/config.json` 中明确选择 wakeEnabled/autoWakeOnMessages/执行策略；再停止并以 start --bridge 重启本实例。只读沙箱仍保留。自动审批可能增加权限和额度消耗，不由监控插件自动开启。首次配置应先手动双向发送与回执，确认目标及预算后再启用。

## 5. 自检与卸载

```powershell
node bin/bridge-between.mjs doctor --mcp
node bin/bridge-between.mjs uninstall --codex 'C:\Path\To\codex.exe' --bridge
```

doctor 报告 configured、collector、MCP工具/只读标记/格式版本和 UI未验证状态。卸载停止本套件实例，通过官方 CLI 移除选定插件，保留用户数据、配置、备份和原始来源。DSH原生挂载由使用者在自己的 profile 中移除。不会按进程名称批量结束 Node/DSH/Codex。
