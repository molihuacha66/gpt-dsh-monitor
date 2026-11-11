# 本地运行与维护

start默认前台运行，--background以隐藏子进程运行；不注册系统服务或开机自启。status/stop通过仅回环、随机控制端口和用户数据目录中的随机凭据控制本实例，不以任意PID结束进程。崩溃遗留记录在确认原PID已不存在后才清理；PID仍存在但控制端点不可达时返回 SERVICE_STATE_UNCERTAIN，需核对具体进程。

settings、数据库、令牌均在用户数据目录，发布目录和缓存只保存程序。Windows凭据继承当前用户目录的系统权限；mode 0600不是Windows ACL隔离证明。同一操作系统用户下的程序属于同一信任边界。桥保存原始通信，monitor写入的是脱敏观察；对自由文本秘密的识别有边界。

monitor本地只读HTTP严格限制Host/Origin与GET。控制端点需要实例凭据。桥两端身份分别使用token.txt和token-codex.txt，服务端绑定身份及collab访问；将桥凭据配置给监控服务是不必要的。监控不会扫描Token文件。

维护命令格式：

```powershell
node bin/bridge-between.mjs maintenance backup --destination 'D:\Backups\fresh.sqlite'
node bin/bridge-between.mjs maintenance verify-backup --backup 'D:\Backups\fresh.sqlite'
node bin/bridge-between.mjs maintenance restore --backup 'D:\Backups\fresh.sqlite' --destination 'D:\Restore\new.sqlite'
node bin/bridge-between.mjs maintenance retention --days 90
node bin/bridge-between.mjs maintenance archive --days 90
```

自定义home用 maintenance --home '<目录>'。目标不能已存在，备份需与manifest一同保存；验证hash、格式和SQLite完整性。恢复只写新文件并清旧运行状态，默认不替换现用库。合法旧库写升级先自动备份校验，未知未来格式拒绝。恢复副本仍绑定原来源/项目，重新采集前先确认路径与绑定。

默认全部保留，archive不带--apply仅预览。若使用者明确执行archive --apply --destination '<新的备份文件>'，先完整备份并校验，再在事务内核对同截止/水位的行哈希，仅清理旧observations并记录归档。当前快照、子会话事件、文件索引和原通信保留。无自动VACUUM；删除产生可复用页，不保证磁盘文件立即缩小。

上限：桥100000行和64MiB选定列快照；DSH完整发现最多512个文件、每次处理32个，轮转延期不等于缺失；历史观察/子会话事件100000条及其他解压/帧/行限制仍保留。Worker V8堆限制不等于全进程RSS硬上限。长时间内存与磁盘趋势仍需目标环境观测。

升级流程：保留home与备份，停止实例，解压新版本到新目录，运行新程序doctor/启动，再通过官方安装流程更新客户端。遇缓存占用先核对客户端状态，不修改缓存或自动改版本号。卸载默认保留数据。SOURCE_UNAVAILABLE检查source和服务；SETUP_REQUIRED先setup；MCP_NOT_READY先确认采集库，再检查客户端MCP日志；界面支持单独验收。
