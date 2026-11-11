import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import type {WorkerSnapshot} from './health.ts';
export class CollectionController{
  worker:Worker|null=null;snapshot:WorkerSnapshot|null=null;error:string|null=null;restarts=0;stopped=false;
  private owner=randomUUID();private timer:ReturnType<typeof setTimeout>|undefined;private watchdog:ReturnType<typeof setInterval>;private lastMessage=Date.now();private failures=0;
  private options:{source:string;output:string;sessions:string;project:string;intervalMs:number};private changed:()=>void;private workerURL:URL;
  constructor(options:{source:string;output:string;sessions:string;project:string;intervalMs:number},changed:()=>void=()=>{},workerURL=new URL('./worker.ts',import.meta.url)){
    this.options=options;this.changed=changed;this.workerURL=workerURL;
    this.start();this.watchdog=setInterval(()=>{if(this.worker&&Date.now()-this.lastMessage>90000){this.error='COLLECTOR_WORKER_TIMEOUT';void this.worker.terminate()}},5000);this.watchdog.unref();
  }
  private start(){if(this.stopped)return;this.lastMessage=Date.now();
    this.snapshot=null;
    let worker:Worker;
    try{worker=new Worker(this.workerURL,{workerData:{...this.options,owner:this.owner,restarts:this.restarts},resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:64,stackSizeMb:8},stdout:true,stderr:true})}
    catch{this.error='COLLECTOR_WORKER_START_FAILED';this.retry();return}
    this.worker=worker;
    // Worker diagnostics may contain native paths. Consume them; expose only fixed status codes.
    worker.stdout?.resume();worker.stderr?.resume();
    worker.on('message',value=>{if(this.worker!==worker)return;this.lastMessage=Date.now();if(value.error){this.error='WORKER_STATE_WRITE_FAILED'}else{this.snapshot=value;this.error=null;this.failures=0}this.changed()});
    worker.on('error',error=>{if(this.worker===worker)this.error=['COLLECTOR_ALREADY_RUNNING','MONITOR_UPGRADE_REQUIRED','MONITOR_MIGRATION_REQUIRES_BACKUP','UNSAFE_OUTPUT_PATH'].includes(error.message)?error.message:'COLLECTOR_WORKER_FAILED'});
    worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=null;this.snapshot=null;if(this.stopped)return;this.error??='COLLECTOR_WORKER_EXITED';this.retry()});
  }
  private retry(){if(this.stopped)return;this.restarts++;this.failures++;this.changed();this.timer=setTimeout(()=>this.start(),Math.min(60000,1000*2**Math.min(this.failures-1,6)))}
  runtime(){const bridge=this.snapshot?.jobs.find(j=>j.name==='bridge'),agent=this.snapshot?.jobs.find(j=>j.name==='agents');return {collecting:!this.stopped,lastError:this.error??(bridge?.phase==='error'?bridge.code:null)??null,agentError:agent?.phase==='error'||agent?.phase==='degraded'?agent.code:null,intervalMs:this.options.intervalMs,workerRestarts:this.restarts}}
  async close(){this.stopped=true;clearInterval(this.watchdog);if(this.timer)clearTimeout(this.timer);const worker=this.worker;if(!worker)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{void worker.terminate()},5000);worker.once('exit',()=>{clearTimeout(timer);resolve()});worker.postMessage('stop')})}
}
