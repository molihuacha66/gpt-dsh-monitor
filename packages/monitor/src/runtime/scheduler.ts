import {safeCode} from '../errors.ts';
export type JobName='bridge'|'agents'|'artifacts';
export type JobOutcome={degraded?:boolean;code?:string;metrics?:Record<string,number>};
export type JobState={name:JobName;phase:'waiting'|'running'|'ok'|'degraded'|'error';runs:number;failures:number;lastStarted:number|null;lastCompleted:number|null;lastSuccess:number|null;durationMs:number;nextAt:number;code:string|null;metrics:Record<string,number>};
export class JobScheduler{
  jobs:{state:JobState;run:()=>JobOutcome|Promise<JobOutcome>}[]=[];
  running=false;
  intervalMs:number;maxBackoffMs:number;clock:()=>number;
  constructor(intervalMs=5000,maxBackoffMs=60000,clock=Date.now){this.intervalMs=intervalMs;this.maxBackoffMs=maxBackoffMs;this.clock=clock}
  add(name:JobName,run:()=>JobOutcome|Promise<JobOutcome>){this.jobs.push({run,state:{name,phase:'waiting',runs:0,failures:0,lastStarted:null,lastCompleted:null,lastSuccess:null,durationMs:0,nextAt:0,code:null,metrics:{}}})}
  snapshot(){return this.jobs.map(job=>structuredClone(job.state))}
  async tick(changed:()=>void=()=>{}){
    if(this.running)return false;this.running=true;
    try{for(const job of this.jobs){if(this.clock()<job.state.nextAt)continue;
      const s=job.state;s.phase='running';s.lastStarted=this.clock();s.runs++;changed();
      try{const outcome=await job.run();s.phase=outcome.degraded?'degraded':'ok';s.failures=0;s.code=outcome.code??null;s.metrics=outcome.metrics??{};if(!outcome.degraded)s.lastSuccess=this.clock()}
      catch(error){s.phase='error';s.failures++;s.code=safeCode(error)}
      s.lastCompleted=this.clock();s.durationMs=Math.max(0,s.lastCompleted-s.lastStarted);s.nextAt=s.lastCompleted+Math.min(this.maxBackoffMs,this.intervalMs*2**Math.min(s.failures,6));changed();
    }return true}finally{this.running=false}
  }
}
