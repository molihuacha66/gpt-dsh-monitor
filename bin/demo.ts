import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {TABLES,COLUMNS} from '../packages/monitor/src/source.ts';
export function createDemo(home:string,project:string){
 const dir=join(home,'demo-source');mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(join(dir,'bridge.sqlite'));try{
 for(const table of TABLES){const columns=COLUMNS[table].split(' ').map(c=>c==='seq'?'seq INTEGER PRIMARY KEY AUTOINCREMENT':`${c} ${/^(version|at|.*_at)$/.test(c)?'INTEGER':'TEXT'}`);db.exec(`CREATE TABLE ${table}(${columns.join(',')}${table==='record_docs'?',PRIMARY KEY(collab,key)':''})`)}
 const statement=db.prepare('INSERT INTO messages(id,collab,sender,recipient,kind,subject,body,reply_to,state,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 statement.run('m_000000000001','default','codex','dsh','task','合成演示：检查示例文件','请检查示例文件。这是安装测试数据。',null,'saved','synthetic-demo',Date.now());
 statement.run('m_000000000002','default','dsh','codex','answer','合成演示：检查结果','示例已检查。\n```monitor-artifacts\n[{"path":"demo-result.md"}]\n```','m_000000000001','saved','synthetic-demo',Date.now()+1);
 }finally{db.close()}
 writeFileSync(join(project,'demo-result.md'),'# 合成演示\n\n此文件由安装演示生成，不是真实用户的聊天或任务。\n',{flag:'wx'});
}
