import {settings} from '../config.ts';
import {resolve} from 'node:path';
import {backupMonitor,verifyBackup,restoreMonitor,retentionPlan,archiveHistory,migrateMonitor} from './database.ts';
import {MonitorError,safeCode} from '../errors.ts';
async function main(){
 const args=process.argv.slice(2),command=args.shift();if(!['backup','verify-backup','restore','retention','archive','migrate'].includes(command??''))throw new MonitorError('INVALID_COMMAND');
 const values:Record<string,string>={};let apply=false;
 while(args.length){const key=args.shift()!;if(key==='--apply'){apply=true;continue}if(!['--database','--destination','--days','--backup'].includes(key)||!args.length||values[key])throw new MonitorError('INVALID_ARGUMENT');values[key]=args.shift()!}
 const database=values['--database']??settings().database,destination=values['--destination'],archive=values['--backup'];
 if(apply&&command!=='archive')throw new MonitorError('INVALID_ARGUMENT');
 let result;
 if(command==='backup'){if(!destination)throw new MonitorError('INVALID_ARGUMENT');result=await backupMonitor(database,destination)}
 else if(command==='verify-backup'){if(!archive)throw new MonitorError('INVALID_ARGUMENT');result=await verifyBackup(archive)}
 else if(command==='restore'){if(!archive||!destination)throw new MonitorError('INVALID_ARGUMENT');result=await restoreMonitor(archive,destination)}
 else if(command==='migrate'){if(!destination)throw new MonitorError('INVALID_ARGUMENT');result=await migrateMonitor(database,destination)}
 else {const days=Number(values['--days']??90);if(command==='archive'&&apply&&!destination)throw new MonitorError('INVALID_ARGUMENT');result=command==='archive'?await archiveHistory(database,destination??'',days,apply):retentionPlan(database,days)}
 console.log(JSON.stringify({ok:true,...result}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,code:safeCode(error)}));process.exitCode=1});
