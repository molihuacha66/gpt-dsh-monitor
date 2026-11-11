# 兼容与验收范围

| 项目 | 本地验证状态 |
|---|---|
| Windows / Node 24.21 | 临时用户目录含中文和空格的运行测试通过 |
| Node最低24.12 | 引擎要求；未逐一测试24.12与所有后续版本 |
| 预构建collector / Worker / HTTP / MCP | 无node_modules的隔离副本通过 |
| Codex portable与legacy配置生成 | 结构及路径测试；新用户真实安装待验收 |
| DSH原生followup和游标 | 真实临时桥＋合成Cordis宿主测试；真实新profile待验收 |
| Codex内嵌新版App | 本次公共包未做真实宿主显示验收 |
| DSH内嵌MCP App | 未确认；不以二进制字符串扫描作支持/不支持结论 |
| macOS / Linux | 部分代码可运行；本预览不声明双端完整支持 |
| 远程/网页客户端 | 本地stdio包不提供远程连接 |

MCP工具协议、MCP Apps扩展、宿主原生插件格式是独立能力。服务端声明ui资源不证明宿主实际渲染。先在目标客户端完成协商、打开界面并观察数据更新，再报告通过。

首版每个实例一个协作号、一个DSH轮询者和明确目标。同一collab多个DSH实例会共享游标；不同collab也不自动带来多会话路由支持。跨机连接、Team/Host事件、无限来源/虚拟化没有纳入。

来源支持当前桥六表及DSH v4日志/descriptor v3，子会话继承边界和白名单与监控核心保持一致。日志未持久化、格式未知、超过预算时报告覆盖缺口，不声称捕获了所有交流。

DSH followup与桥游标提交不在同一原子事务中；宿主实际接受后发生异常或提交前进程崩溃，重试可能重复投递。本预览不承诺exactly-once。自动followup默认关闭；模型按原桥消息ID判断是否已经处理，网络重试复用client_msg_id，并核对审计，避免重复执行。

参考：[官方插件分发](https://developers.openai.com/plugins/build/plugins)、[MCP Apps宿主能力](https://modelcontextprotocol.io/extensions/apps/overview)。
