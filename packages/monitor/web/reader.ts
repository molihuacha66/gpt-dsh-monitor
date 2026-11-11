import type { ReadRequest } from '../src/conversation/service.ts';
export type Reader = <T=Record<string,unknown>>(input:ReadRequest)=>Promise<T>;
export const browserReader:Reader=async input=>{
  const params=new URLSearchParams();for(const [k,v]of Object.entries(input))if(v!==undefined)params.set(k,k==='includeTests'?(v?'1':'0'):String(v));
  const response=await fetch(`/api/read?${params}`),data=await response.json();
  if(!response.ok||!data.ok)throw new Error(data.code??'MONITOR_UNAVAILABLE');return data;
};
