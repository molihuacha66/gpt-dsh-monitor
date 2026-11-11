---
name: open-monitor
description: Open the installed 桥间 GPT–DSH read-only MCP App, or diagnose missing monitor tools without substituting a website.
---

# Open 桥间

Use this workflow when the user invokes this plugin or asks to open its GPT–DSH communication monitor.

1. Discover this plugin's `open_monitor` tool (title: GPT 与 DSH 协作会话). If it is available, call it. The host renders the MCP App from its UI resource; do not substitute a browser URL or open the raw bundled HTML.
2. If `open_monitor` is not available, stop the opening attempt and tell the user: “桥间插件已选中，但监控工具尚未加载，App 暂时无法打开。” Report whether `open_monitor` and `monitor_read` were found; do not print unrelated tool inventories. Keep the status unverified until the real host opens the App.
3. If the tool returns an error, report its fixed error code. Do not claim the interface loaded solely because a tool call succeeded.

Do not silently fall back to a website, read a project README to find a browser replacement, create another chat, change client configuration, or restart the client. The localhost Dashboard is a separate entry point and may be opened only when the user requests the website/Dashboard or agrees to that fallback.

Both tools read the already-collected, redacted local snapshot. They do not send bridge messages, acknowledge messages, alter tasks, start collection, or write source data. A running local Dashboard/collector supplies new snapshots. File previews show current content, not historical versions or proof of authorship.
