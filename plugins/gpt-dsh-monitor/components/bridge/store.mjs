// Modified for portable distribution: local configuration, isolated lifecycle and explicit cursor commits.
/**
 * store.mjs — 桥的账本。
 *
 * 一条原则：**SQLite 是唯一权威**，内存只是缓存。任何"投递成功"都必须先落库。
 *
 * 用 node:sqlite（Node 22.5+ 内置，本机 v24.21.0 可用），零外部依赖。
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PARTICIPANTS = ['dsh', 'codex', 'user'];

export const MESSAGE_KINDS = [
  'discussion', // 讨论
  'question',   // 提问
  'answer',     // 回答
  'task',       // 派活
  'progress',   // 进度
  'evidence',   // 证据
  'objection',  // 异议
  'decision',   // 决定
  'note',       // 备注
];

export const MESSAGE_STATES = ['saved', 'delivered', 'read', 'replied'];

export const TASK_STATES = [
  'created',    // 已创建
  'accepted',   // 已接受
  'running',    // 执行中
  'done',       // 完成
  'failed',     // 失败
  'rejected',   // 拒绝
  'transferred',// 转交
  'cancelled',  // 取消
];

export const RECORD_KEYS = [
  'goal',        // 用户目标
  'constraints', // 约束
  'facts',       // 已确认事实（含证据引用）
  'plan',        // 当前方案
  'decisions',   // 双方已确认的决定
  'disputes',    // 待解决分歧
  'ownership',   // 任务归属
  'artifacts',   // 产物位置
];

const TASK_TRANSITIONS = {
  created: ['accepted', 'rejected', 'transferred', 'cancelled'],
  accepted: ['running', 'done', 'failed', 'transferred', 'cancelled'],
  running: ['done', 'failed', 'transferred', 'cancelled'],
  rejected: ['created'],
  transferred: ['accepted', 'running'],
  done: [],
  failed: ['created'],
  cancelled: [],
};

const MESSAGE_TRANSITIONS = {
  saved: ['delivered', 'read', 'replied'],
  delivered: ['read', 'replied'],
  read: ['replied'],
  replied: [],
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  collab       TEXT NOT NULL,
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject      TEXT,
  body         TEXT NOT NULL,
  source       TEXT NOT NULL,
  reply_to     TEXT,
  client_msg_id TEXT,
  state        TEXT NOT NULL DEFAULT 'saved',
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at      INTEGER,
  replied_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_client
  ON messages(collab, sender, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_messages_inbox ON messages(collab, recipient, seq);

CREATE TABLE IF NOT EXISTS tasks (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  collab      TEXT NOT NULL,
  parent_id   TEXT,
  title       TEXT NOT NULL,
  brief       TEXT,
  assignee    TEXT NOT NULL,
  creator     TEXT NOT NULL,
  state       TEXT NOT NULL,
  deps        TEXT NOT NULL DEFAULT '[]',
  result      TEXT,
  artifacts   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_collab ON tasks(collab, state);

CREATE TABLE IF NOT EXISTS task_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL,
  actor     TEXT NOT NULL,
  from_state TEXT,
  to_state  TEXT NOT NULL,
  note      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS record_docs (
  collab     TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  value      TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collab, key)
);

CREATE TABLE IF NOT EXISTS record_history (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  collab     TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  value      TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  collab      TEXT NOT NULL,
  participant TEXT NOT NULL,
  last_seq    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (collab, participant)
);

CREATE TABLE IF NOT EXISTS budget (
  collab        TEXT PRIMARY KEY,
  max_messages  INTEGER,
  max_turns     INTEGER,
  deadline_at   INTEGER,
  used_messages INTEGER NOT NULL DEFAULT 0,
  used_turns    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);
`;

function nowMs() {
  return Date.now();
}

function newId(prefix) {
  // 短、可读、不会在界面里被当成 UUID 遮蔽
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new BridgeError('bad_argument', `${label} 必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`);
  }
}

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 打开账本。
 * @param {string} dataDir 数据目录（会被创建）
 */
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'bridge.sqlite'));
  db.exec(SCHEMA);

  const stmts = {
    insertMessage: db.prepare(`
      INSERT INTO messages (id, collab, sender, recipient, kind, subject, body, source, reply_to, client_msg_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?)`),
    byClientId: db.prepare(`SELECT * FROM messages WHERE collab = ? AND sender = ? AND client_msg_id = ?`),
    byId: db.prepare(`SELECT * FROM messages WHERE id = ?`),
    markState: db.prepare(`UPDATE messages SET state = ?, delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?), replied_at = COALESCE(replied_at, ?) WHERE id = ?`),
    // 收件箱：排除自己发的。`both` 广播会同时给两边，但发件人自己不该被自己的消息叫醒。
    inbox: db.prepare(`SELECT * FROM messages WHERE collab = ? AND recipient IN (?, 'both') AND seq > ? AND sender != ? ORDER BY seq ASC LIMIT ?`),
    // 完整往来：双向、含自己发出去的。只读，不看 recipient。
    transcriptAfter: db.prepare(`SELECT * FROM messages WHERE collab = ? AND seq > ? ORDER BY seq ASC LIMIT ?`),
    transcriptRecent: db.prepare(`SELECT * FROM messages WHERE collab = ? ORDER BY seq DESC LIMIT ?`),
    evidenceMessages: db.prepare(`SELECT * FROM messages WHERE collab = ? AND kind = 'evidence' ORDER BY seq ASC`),
    // 产物要挂在产生它的那一轮对话下面：找时间上不晚于该时刻的最后一条消息
    lastSeqBefore: db.prepare(`SELECT seq FROM messages WHERE collab = ? AND created_at <= ? ORDER BY seq DESC LIMIT 1`),
    insertTask: db.prepare(`
      INSERT INTO tasks (id, collab, parent_id, title, brief, assignee, creator, state, deps, result, artifacts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`),
    taskById: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    updateTaskState: db.prepare(`UPDATE tasks SET state = ?, result = COALESCE(?, result), artifacts = COALESCE(?, artifacts), updated_at = ? WHERE id = ?`),
    tasksByCollab: db.prepare(`SELECT * FROM tasks WHERE collab = ? ORDER BY seq ASC`),
    insertTaskEvent: db.prepare(`INSERT INTO task_events (task_id, actor, from_state, to_state, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    getRecord: db.prepare(`SELECT * FROM record_docs WHERE collab = ? AND key = ?`),
    allRecords: db.prepare(`SELECT * FROM record_docs WHERE collab = ?`),
    upsertRecord: db.prepare(`
      INSERT INTO record_docs (collab, key, version, value, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collab, key) DO UPDATE SET version = excluded.version, value = excluded.value,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
    insertRecordHistory: db.prepare(`INSERT INTO record_history (collab, key, version, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)`),
    getCursor: db.prepare(`SELECT last_seq FROM cursors WHERE collab = ? AND participant = ?`),
    setCursor: db.prepare(`
      INSERT INTO cursors (collab, participant, last_seq, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(collab, participant) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`),
    getBudget: db.prepare(`SELECT * FROM budget WHERE collab = ?`),
    ensureBudget: db.prepare(`INSERT OR IGNORE INTO budget (collab, updated_at) VALUES (?, ?)`),
    bumpBudget: db.prepare(`UPDATE budget SET used_messages = used_messages + ?, used_turns = used_turns + ?, updated_at = ? WHERE collab = ?`),
    audit: db.prepare(`INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`),
  };

  function audit(actor, action, detail) {
    try {
      stmts.audit.run(nowMs(), String(actor), String(action), detail === undefined ? null : JSON.stringify(detail));
    } catch {
      /* 审计写失败不该拦业务 */
    }
  }

  function checkBudget(collab) {
    stmts.ensureBudget.run(collab, nowMs());
    const row = stmts.getBudget.get(collab);
    if (!row) return;
    if (row.deadline_at && nowMs() > row.deadline_at) {
      throw new BridgeError('budget_exceeded', `协作 ${collab} 已超过时限，请交给用户决定是否继续`, { budget: row });
    }
    if (row.max_messages != null && row.used_messages >= row.max_messages) {
      throw new BridgeError('budget_exceeded', `协作 ${collab} 已达到消息上限 ${row.max_messages}，请交给用户决定是否继续`, { budget: row });
    }
    if (row.max_turns != null && row.used_turns >= row.max_turns) {
      throw new BridgeError('budget_exceeded', `协作 ${collab} 已达到执行轮次上限 ${row.max_turns}，请交给用户决定是否继续`, { budget: row });
    }
  }

  function rowToMessage(row) {
    return {
      id: row.id,
      seq: row.seq,
      collab: row.collab,
      sender: row.sender,
      recipient: row.recipient,
      kind: row.kind,
      subject: row.subject ?? undefined,
      body: row.body,
      source: row.source,
      reply_to: row.reply_to ?? undefined,
      state: row.state,
      created_at: row.created_at,
      delivered_at: row.delivered_at ?? undefined,
      read_at: row.read_at ?? undefined,
      replied_at: row.replied_at ?? undefined,
    };
  }

  function rowToTask(row) {
    return {
      id: row.id,
      collab: row.collab,
      parent_id: row.parent_id ?? undefined,
      title: row.title,
      brief: row.brief ?? undefined,
      assignee: row.assignee,
      creator: row.creator,
      state: row.state,
      deps: JSON.parse(row.deps || '[]'),
      result: row.result ?? undefined,
      artifacts: row.artifacts ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  return {
    db,

    close() {
      try { db.close(); } catch { /* 已关闭 */ }
    },

    /** 发一条消息。同一个 client_msg_id 重复提交返回原记录（幂等）。 */
    sendMessage(input) {
      const { collab = 'default', sender, recipient, kind, subject, body, source, reply_to, client_msg_id } = input ?? {};
      assertOneOf(sender, PARTICIPANTS, 'sender');
      if (recipient !== 'both') assertOneOf(recipient, PARTICIPANTS, 'recipient');
      assertOneOf(kind, MESSAGE_KINDS, 'kind');
      if (typeof body !== 'string' || body.trim() === '') {
        throw new BridgeError('bad_argument', 'body 不能为空');
      }

      if (client_msg_id) {
        const existing = stmts.byClientId.get(collab, sender, String(client_msg_id));
        if (existing) return { message: rowToMessage(existing), duplicate: true };
      }

      checkBudget(collab);

      if (reply_to) {
        const target = stmts.byId.get(String(reply_to));
        if (!target) throw new BridgeError('not_found', `reply_to 指向的消息 ${reply_to} 不存在`);
        if (target.recipient !== 'both' && target.recipient !== sender) {
          throw new BridgeError('bad_argument', `消息 ${reply_to} 的收件人是 ${target.recipient}，${sender} 不能回复它`);
        }
      }

      const id = newId('m_');
      const at = nowMs();
      db.exec('BEGIN');
      try {
        stmts.insertMessage.run(
          id, collab, sender, recipient, kind,
          subject == null ? null : String(subject),
          String(body), String(source ?? sender),
          reply_to ? String(reply_to) : null,
          client_msg_id ? String(client_msg_id) : null,
          at,
        );
        if (reply_to) {
          stmts.markState.run('replied', null, null, at, String(reply_to));
        }
        stmts.bumpBudget.run(1, 0, at, collab);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (client_msg_id) {
          const raced = stmts.byClientId.get(collab, sender, String(client_msg_id));
          if (raced) return { message: rowToMessage(raced), duplicate: true };
        }
        throw error;
      }
      audit(sender, 'message.send', { id, recipient, kind });
      return { message: rowToMessage(stmts.byId.get(id)), duplicate: false };
    },

    /** 取收件箱：返回 seq 大于 since 的、发给 participant 或 both 的消息。 */
    pollInbox({ collab = 'default', participant, since = 0, limit = 50, ackDelivered = true }) {
      assertOneOf(participant, ['dsh', 'codex'], 'participant');
      const rows = stmts.inbox.all(collab, participant, Number(since) || 0, participant, Math.min(Math.max(Number(limit) || 50, 1), 200));
      const at = nowMs();
      if (ackDelivered) {
        for (const row of rows) {
          if (row.state === 'saved') {
            stmts.markState.run('delivered', at, null, null, row.id);
            // 同一行对象回填，免得返回值还写着 saved
            row.state = 'delivered';
            row.delivered_at = row.delivered_at ?? at;
          }
        }
      }
      const messages = rows.map(rowToMessage);
      const nextSince = messages.length > 0 ? messages[messages.length - 1].seq : (Number(since) || 0);
      return { messages, next_since: nextSince };
    },

    /** 读完整往来（双向）。只读：不推进游标、不改状态。
     *  每次唤醒都是新进程，所以这是 Codex 唯一能「接上前几轮」的窗口。 */
    getTranscript({ collab = 'default', since = 0, limit = 50 }) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const from = Number(since) || 0;
      const rows = from > 0
        ? stmts.transcriptAfter.all(collab, from, n)
        : stmts.transcriptRecent.all(collab, n).reverse();
      const messages = rows.map(rowToMessage);
      const nextSince = messages.length > 0 ? messages[messages.length - 1].seq : from;
      return { messages, next_since: nextSince };
    },

    /** 汇总这个协作里出现过的「产物」：任务声明的 artifacts + evidence 正文里提到的绝对路径。
     *  只收集路径和归属，不碰文件系统——存在性/大小由 Host 侧补。
     */
    listArtifacts({ collab = 'default' } = {}) {
      const seen = new Map();
      const add = (path, meta) => {
        const key = String(path).trim().toLowerCase();
        if (!key) return;
        const anchorSeq = meta.anchor_seq ?? null;
        const prev = seen.get(key);
        if (prev) {
          // 同一个文件被多处提到：保留最早的时间，合并来源
          prev.sources = [...new Set([...(prev.sources ?? []), meta.source])];
          prev.first_seen_at = Math.min(prev.first_seen_at ?? meta.at ?? 0, meta.at ?? 0) || prev.first_seen_at;
          // 锚点取更早的那条：产物出现在它第一次被提起的那一轮
          if (anchorSeq != null && (prev.anchor_seq == null || anchorSeq < prev.anchor_seq)) {
            prev.anchor_seq = anchorSeq;
          }
          if (!prev.task_title && meta.task_title) {
            prev.task_title = meta.task_title;
            prev.task_id = meta.task_id;
          }
          return;
        }
        seen.set(key, {
          path: String(path).trim(),
          title: meta.title ?? null,
          sources: [meta.source],
          task_id: meta.task_id ?? null,
          task_title: meta.task_title ?? null,
          by: meta.by ?? null,
          first_seen_at: meta.at ?? 0,
          anchor_seq: anchorSeq,
        });
      };

      // 1. 任务里声明的产物
      for (const t of stmts.tasksByCollab.all(collab)) {
        let list = [];
        const raw = t.artifacts;
        if (raw) {
          try {
            list = JSON.parse(raw);
          } catch {
            list = String(raw).split(/\r?\n/);
          }
        }
        if (!Array.isArray(list)) list = [list];
        for (const item of list) {
          if (!item) continue;
          const taskAnchor = stmts.lastSeqBefore.get(collab, t.updated_at)?.seq ?? null;
          if (typeof item === 'string') {
            add(item, {
              source: 'task', task_id: t.id, task_title: t.title, by: t.assignee,
              at: t.updated_at, anchor_seq: taskAnchor,
            });
          } else if (typeof item === 'object') {
            const path = item.path ?? item.file ?? item.location;
            if (!path) continue;
            add(path, {
              source: 'task', task_id: t.id, task_title: t.title, by: t.assignee,
              at: t.updated_at, title: item.title ?? item.label ?? null, anchor_seq: taskAnchor,
            });
          }
        }
      }

      // 2. evidence 正文里的绝对路径（Windows 盘符开头）
      const pathRe = /[A-Za-z]:\\[^\s"'<>|*?`\r\n]+/g;
      for (const m of stmts.evidenceMessages.all(collab)) {
        const body = String(m.body ?? '');
        for (const hit of body.match(pathRe) ?? []) {
          const cleaned = hit.replace(/[，。,.;；:：)\]}]+$/, '');
          if (!/\.[A-Za-z0-9]{1,8}$/.test(cleaned)) continue; // 只收看起来像文件的
          add(cleaned, { source: 'evidence', at: m.created_at, by: m.sender, anchor_seq: m.seq });
        }
      }

      const items = [...seen.values()].sort((a, b) => (a.first_seen_at ?? 0) - (b.first_seen_at ?? 0));
      return { artifacts: items };
    },

    /** 读并确认（把 delivered 提升为 read）。 */
    ackRead(ids) {
      const at = nowMs();
      const updated = [];
      for (const id of ids ?? []) {
        const row = stmts.byId.get(String(id));
        if (!row) continue;
        if (row.state === 'delivered' || row.state === 'saved') {
          stmts.markState.run('read', null, at, null, row.id);
          updated.push(String(id));
        }
      }
      return { updated };
    },

    getMessage(id) {
      const row = stmts.byId.get(String(id));
      return row ? rowToMessage(row) : undefined;
    },

    /** 创建任务。deps 里的任务必须已存在。 */
    createTask(input) {
      const { collab = 'default', title, brief, assignee, creator, parent_id, deps = [] } = input ?? {};
      if (!title || String(title).trim() === '') throw new BridgeError('bad_argument', 'title 不能为空');
      assertOneOf(assignee, ['dsh', 'codex'], 'assignee');
      assertOneOf(creator, PARTICIPANTS, 'creator');
      for (const dep of deps) {
        const row = stmts.taskById.get(String(dep));
        if (!row) throw new BridgeError('bad_argument', `依赖任务 ${dep} 不存在`);
      }
      if (parent_id && !stmts.taskById.get(String(parent_id))) {
        throw new BridgeError('bad_argument', `父任务 ${parent_id} 不存在`);
      }
      checkBudget(collab);
      const id = newId('t_');
      const at = nowMs();
      stmts.insertTask.run(
        id, collab, parent_id ? String(parent_id) : null,
        String(title), brief == null ? null : String(brief),
        assignee, creator, JSON.stringify([...deps].map(String)), null, null, at, at,
      );
      stmts.insertTaskEvent.run(id, creator, null, 'created', null, at);
      stmts.bumpBudget.run(0, 1, at, collab);
      audit(creator, 'task.create', { id, assignee });
      return rowToTask(stmts.taskById.get(id));
    },

    /** 任务状态迁移。非法迁移拒绝。 */
    getTask(id) {
      const row = stmts.taskById.get(String(id));
      return row ?? undefined;
    },

    moveTask(input) {
      const { id, state, actor, note, result, artifacts, collab } = input ?? {};
      const row = stmts.taskById.get(String(id));
      if (!row) throw new BridgeError('not_found', `任务 ${id} 不存在`);
      // 协作隔离：只按 id 操作的话，知道 id 就能跨协作改别人的任务。
      if (collab && row.collab !== collab) {
        throw new BridgeError('forbidden', `任务 ${id} 属于协作 "${row.collab}"，无权从 "${collab}" 操作它`);
      }
      assertOneOf(state, TASK_STATES, 'state');
      assertOneOf(actor, PARTICIPANTS, 'actor');
      // 权限：只有该任务的负责人、创建者，或人工（user）能改它的状态。
      // 光校验枚举等于谁都替别人报完成 —— Codex 只读核查里点出来的。
      if (actor !== 'user' && actor !== row.assignee && actor !== row.creator) {
        throw new BridgeError(
          'forbidden',
          `任务 ${id} 的负责人是 ${row.assignee}、创建者是 ${row.creator}，${actor} 无权改它的状态`,
        );
      }
      const allowed = TASK_TRANSITIONS[row.state] ?? [];
      if (!allowed.includes(state)) {
        throw new BridgeError('bad_transition', `任务 ${id} 不能从 ${row.state} 变成 ${state}；允许：${allowed.join(', ') || '（终态）'}`);
      }
      // 完成/失败必须留结论：只改状态说明不了任何事，
      // 这正是「不能把投递成功当作完成」要防的那种含糊。
      if ((state === 'done' || state === 'failed') && (result == null || String(result).trim() === '')) {
        throw new BridgeError('bad_argument', `任务 ${id} 标 ${state} 时必须给 result（一句话结论或证据编号），否则无法与「只是操作成功」区分`);
      }
      if (state === 'done' || state === 'failed') {
        const deps = JSON.parse(row.deps || '[]');
        for (const dep of deps) {
          const depRow = stmts.taskById.get(dep);
          if (!depRow || depRow.state !== 'done') {
            throw new BridgeError('dependency_pending', `任务 ${id} 依赖的 ${dep} 尚未完成`);
          }
        }
      }
      const at = nowMs();
      stmts.updateTaskState.run(state, result === undefined ? null : String(result), artifacts === undefined ? null : JSON.stringify(artifacts), at, String(id));
      stmts.insertTaskEvent.run(String(id), actor, row.state, state, note == null ? null : String(note), at);

      // 任务收尾时在时间线上留一条记录。
      // 两个作用：一是「这件活干完了」本来就该出现在对话里；
      // 二是产物的锚点能落在它身上，而不是落在恰好那一刻前后的某条无关消息下面。
      if (state === 'done' || state === 'failed') {
        const mark = state === 'done' ? '完成' : '失败';
        const lines = [];
        if (result != null && String(result).trim()) lines.push(String(result).trim());
        const list = Array.isArray(artifacts) ? artifacts : [];
        if (list.length > 0) {
          if (lines.length) lines.push('');
          lines.push(`产出 ${list.length} 个文件：`);
          for (const item of list) {
            const p = typeof item === 'string' ? item : (item?.path ?? item?.file ?? item?.location);
            if (p) lines.push(`- ${p}`);
          }
        }
        stmts.insertMessage.run(
          newId('m_'), row.collab, actor, 'both', 'progress',
          `任务${mark}：${row.title}`, lines.join('\n') || `任务${mark}`,
          actor, null, null, at,
        );
      }

      audit(actor, 'task.move', { id, from: row.state, to: state });
      return rowToTask(stmts.taskById.get(id));
    },

    listTasks(collab = 'default') {
      return stmts.tasksByCollab.all(collab).map(rowToTask);
    },

    getTask(id) {
      const row = stmts.taskById.get(String(id));
      return row ? rowToTask(row) : undefined;
    },

    /** 读共同记录。 */
    getRecord(collab = 'default') {
      const docs = {};
      let version = 0;
      for (const row of stmts.allRecords.all(collab)) {
        docs[row.key] = { value: JSON.parse(row.value), version: row.version, updated_by: row.updated_by, updated_at: row.updated_at };
        version = Math.max(version, row.version);
      }
      return { collab, docs, version };
    },

    /**
     * 改一个记录分区，带乐观锁。
     * expected_version 省略时不检查；给了就必须等于当前版本。
     */
    patchRecord(input) {
      const { collab = 'default', key, value, expected_version, updated_by } = input ?? {};
      assertOneOf(key, RECORD_KEYS, 'key');
      assertOneOf(updated_by, ['dsh', 'codex', 'user'], 'updated_by');
      const current = stmts.getRecord.get(collab, key);
      const currentVersion = current ? current.version : 0;
      if (expected_version != null && Number(expected_version) !== currentVersion) {
        throw new BridgeError(
          'version_conflict',
          `记录分区 ${key} 的版本是 ${currentVersion}，不是 ${expected_version}；请先读取最新记录再改`,
          { current_version: currentVersion },
        );
      }
      const nextVersion = currentVersion + 1;
      const at = nowMs();
      const text = JSON.stringify(value ?? null);
      db.exec('BEGIN');
      try {
        stmts.upsertRecord.run(collab, key, nextVersion, text, updated_by, at);
        stmts.insertRecordHistory.run(collab, key, nextVersion, text, updated_by, at);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      audit(updated_by, 'record.patch', { key, version: nextVersion });
      return { key, version: nextVersion };
    },

    getCursor(collab, participant) {
      const row = stmts.getCursor.get(collab, participant);
      return row ? row.last_seq : 0;
    },

    setCursor(collab, participant, seq) {
      stmts.setCursor.run(collab, participant, Number(seq) || 0, nowMs());
    },

    setBudget(collab, patch) {
      stmts.ensureBudget.run(collab, nowMs());
      const row = stmts.getBudget.get(collab);
      const maxMessages = patch?.max_messages === undefined ? row.max_messages : patch.max_messages;
      const maxTurns = patch?.max_turns === undefined ? row.max_turns : patch.max_turns;
      const deadline = patch?.deadline_at === undefined ? row.deadline_at : patch.deadline_at;
      db.prepare(`UPDATE budget SET max_messages = ?, max_turns = ?, deadline_at = ?, updated_at = ? WHERE collab = ?`)
        .run(maxMessages ?? null, maxTurns ?? null, deadline ?? null, nowMs(), collab);
      return this.getBudget(collab);
    },

    getBudget(collab) {
      stmts.ensureBudget.run(collab, nowMs());
      return stmts.getBudget.get(collab);
    },

    /** 预算门禁：超限直接抛 budget_exceeded。 */
    assertBudget(collab = 'default') {
      checkBudget(collab);
    },

    /** 记一次实际执行（唤醒 Codex 会真的跑一轮，必须计次）。 */
    recordTurn(collab = 'default') {
      stmts.ensureBudget.run(collab, nowMs());
      stmts.bumpBudget.run(0, 1, nowMs(), collab);
      return stmts.getBudget.get(collab);
    },

    stats(collab = 'default') {
      const messageCount = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE collab = ?`).get(collab).n;
      const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE collab = ?`).get(collab).n;
      const pending = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE collab = ? AND state IN ('saved','delivered')`).get(collab).n;
      return { collab, messages: messageCount, tasks: taskCount, pending_messages: pending, budget: this.getBudget(collab) };
    },

    audit(actor, action, detail) {
      audit(actor, action, detail);
    },

    /** 仅供测试/诊断：生成一个稳定的协作号。 */
    newCollabId() {
      return `c_${randomUUID().slice(0, 8)}`;
    },
  };
}