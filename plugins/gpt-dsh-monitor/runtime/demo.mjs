import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);

// bin/demo.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// packages/monitor/src/source.ts
import { DatabaseSync } from "node:sqlite";
var COLUMNS = {
  messages: "seq id collab sender recipient kind subject body source reply_to client_msg_id state created_at delivered_at read_at replied_at",
  tasks: "seq id collab parent_id title brief assignee creator state deps result artifacts created_at updated_at",
  task_events: "seq task_id actor from_state to_state note created_at",
  record_docs: "collab key version value updated_by updated_at",
  record_history: "seq collab key version value updated_by updated_at",
  audit: "seq at actor action detail"
};
var TABLES = Object.keys(COLUMNS);

// bin/demo.ts
function createDemo(home, project) {
  const dir = join(home, "demo-source");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync2(join(dir, "bridge.sqlite"));
  try {
    for (const table of TABLES) {
      const columns = COLUMNS[table].split(" ").map((c) => c === "seq" ? "seq INTEGER PRIMARY KEY AUTOINCREMENT" : `${c} ${/^(version|at|.*_at)$/.test(c) ? "INTEGER" : "TEXT"}`);
      db.exec(`CREATE TABLE ${table}(${columns.join(",")}${table === "record_docs" ? ",PRIMARY KEY(collab,key)" : ""})`);
    }
    const statement = db.prepare("INSERT INTO messages(id,collab,sender,recipient,kind,subject,body,reply_to,state,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    statement.run("m_000000000001", "default", "codex", "dsh", "task", "\u5408\u6210\u6F14\u793A\uFF1A\u68C0\u67E5\u793A\u4F8B\u6587\u4EF6", "\u8BF7\u68C0\u67E5\u793A\u4F8B\u6587\u4EF6\u3002\u8FD9\u662F\u5B89\u88C5\u6D4B\u8BD5\u6570\u636E\u3002", null, "saved", "synthetic-demo", Date.now());
    statement.run("m_000000000002", "default", "dsh", "codex", "answer", "\u5408\u6210\u6F14\u793A\uFF1A\u68C0\u67E5\u7ED3\u679C", '\u793A\u4F8B\u5DF2\u68C0\u67E5\u3002\n```monitor-artifacts\n[{"path":"demo-result.md"}]\n```', "m_000000000001", "saved", "synthetic-demo", Date.now() + 1);
  } finally {
    db.close();
  }
  writeFileSync(join(project, "demo-result.md"), "# \u5408\u6210\u6F14\u793A\n\n\u6B64\u6587\u4EF6\u7531\u5B89\u88C5\u6F14\u793A\u751F\u6210\uFF0C\u4E0D\u662F\u771F\u5B9E\u7528\u6237\u7684\u804A\u5929\u6216\u4EFB\u52A1\u3002\n", { flag: "wx" });
}
export {
  createDemo
};
