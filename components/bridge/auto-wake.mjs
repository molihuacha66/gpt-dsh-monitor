// Modified for portable distribution: local configuration, isolated lifecycle and explicit cursor commits.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function createAutoWakeQueue({enabled,wake,isBusy=()=>false,audit,maxQueue=32,busyWaitMs=600000}){
  const queue=[];let active=false,closed=false;
  const idle=new Set();
  const log=(action,detail)=>{try{audit(action,detail)}catch{console.error('[bridge] auto_wake_audit_failed')}};
  const settle=()=>{if(!active&&!queue.length){for(const resolve of idle)resolve();idle.clear()}};
  async function drain(){
    if(active)return;active=true;
    try{while(queue.length){const message=queue.shift(),start=Date.now();
      try{
        while(isBusy()){if(Date.now()-start>=busyWaitMs){const error=new Error('busy');error.code='busy';throw error}await pause(100)}
        log('codex.auto_wake.started',{collab:message.collab,message_id:message.id});
        const result=await wake(message);
        log('codex.auto_wake.finished',{collab:message.collab,message_id:message.id,ok:result.ok===true,code:result.code??'unknown',recorded_message_id:result.recorded_message_id??null});
      }catch(error){log('codex.auto_wake.finished',{collab:message.collab,message_id:message.id,ok:false,code:['busy','budget_exceeded','wake_disabled','codex_not_found'].includes(error?.code)?error.code:'wake_failed'})}
    }}finally{active=false;settle()}
  }
  return {
    enqueue(message,{duplicate=false}={}){
      if(!enabled||closed||duplicate||message.sender!=='dsh'||message.recipient!=='codex'||!['question','task'].includes(message.kind))return {status:'not_requested'};
      if(queue.length>=maxQueue){log('codex.auto_wake.skipped',{collab:message.collab,message_id:message.id,code:'queue_full'});return {status:'queue_full'}}
      queue.push(message);log('codex.auto_wake.queued',{collab:message.collab,message_id:message.id});
      // The original send response is independent of the asynchronous execution result.
      setImmediate(()=>{void drain()});return {status:'queued',message_id:message.id};
    },
    stats(){return {enabled:enabled===true,pending:queue.length,active}},
    whenIdle(){return !active&&!queue.length?Promise.resolve():new Promise(resolve=>idle.add(resolve))},
    async close(){closed=true;await this.whenIdle()},
  };
}
