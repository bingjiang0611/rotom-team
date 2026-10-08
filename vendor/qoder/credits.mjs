import {QoderError} from './auth.mjs';
export const QUOTA_URL='https://openapi.qoder.sh/api/v2/quota/usage';
export const CREDIT_ENTRY='qoder-credit-observation-v1';
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// Credit is not USD. Missing/invalid metering is never an observed zero.
export function creditFields(usage){
 if(!record(usage))return{};const fields={};
 for(const key of ['credits','original_credits','billable'])if(Object.hasOwn(usage,key))fields[key]=(key==='billable'?typeof usage[key]==='boolean':finite(usage[key]))?usage[key]:null;
 return fields;
}
export function createCreditCollector(){
 const values={};let invalid=false;
 return {
  observe(usage){
   if(!record(usage))return;
   for(const key of ['credits','original_credits','billable'])if(Object.hasOwn(usage,key)){
    if(key==='billable'?typeof usage[key]!=='boolean':!finite(usage[key]))invalid=true;
    else values[key]=usage[key];
   }
  },
  finish(outcome){
   const known=outcome==='complete'&&!invalid&&typeof values.billable==='boolean'&&finite(values.credits);
   return{status:known?'reported':'unknown',outcome,...known?{credits:values.credits,billable:values.billable}:{},...finite(values.original_credits)?{originalCredits:values.original_credits}:{}};
  },
 };
}
export function creditSummary(entries,sessionId){
 const seen=new Map();let credits=0,reported=0,unknown=0;
 for(const e of entries){
  if(!record(e)||e.type!=='custom'||e.customType!==CREDIT_ENTRY)continue;
  const d=e.data;if(!record(d)||d.sessionId!==sessionId)continue;
  if(d.version!==1||typeof d.requestId!=='string'||!d.requestId||d.requestId.length>128){unknown++;continue;}
  const prior=seen.get(d.requestId),signature=JSON.stringify([typeof d.modelId==='string'&&d.modelId.length<=96?d.modelId:null,d.status==='reported',d.outcome==='complete',finite(d.credits)?d.credits:null,typeof d.billable==='boolean'?d.billable:null]);
  if(prior){if(prior.signature!==signature)prior.conflict=true;continue;}
  seen.set(d.requestId,{data:d,signature,conflict:false});
 }
 for(const {data:d,conflict} of seen.values()){
  if(!conflict&&typeof d.modelId==='string'&&d.modelId.length>0&&d.modelId.length<=96&&d.status==='reported'&&d.outcome==='complete'&&finite(d.credits)&&typeof d.billable==='boolean'){if(d.billable)credits+=d.credits;reported++;}else unknown++;
 }
 return{credits:reported&&Number.isFinite(credits)?credits:null,reported,unknown};
}
export function normalizeQuota(data,credential){
 const uid=data?.user_id??data?.userId;
 if(!record(data)||typeof credential?.uid!=='string'||!credential.uid||(typeof uid!=='string'&&!Number.isSafeInteger(uid))||String(uid)!==credential.uid)throw new QoderError('quota_identity_mismatch');
 if(!['user_quota','userQuota','add_on_quota','addOnQuota','org_resource_package','orgResourcePackage'].some(k=>Object.hasOwn(data,k)))throw new QoderError('quota_schema_unavailable');
 const pools={};
 for(const [name,raw] of [['plan',data.user_quota??data.userQuota],['addon',data.add_on_quota??data.addOnQuota],['shared',data.org_resource_package??data.orgResourcePackage]]){
  if(raw==null){pools[name]=null;continue;}
  if(!record(raw))throw new QoderError('quota_schema_unavailable');
  pools[name]={unit:typeof raw.unit==='string'&&/^credits?$/i.test(raw.unit)?'credits':'unknown',total:finite(raw.total??raw.cap)?raw.total??raw.cap:null,used:finite(raw.used)?raw.used:null,remaining:finite(raw.remaining)?raw.remaining:null};
 }
 return{pools,observedAt:Date.now()};
}
export async function fetchQuota(credential,{fetchImpl=globalThis.fetch,signal}={}){
 if(typeof credential?.accessToken!=='string'||!credential.accessToken||/[\x00-\x20\x7f]/.test(credential.accessToken)||!credential.uid)throw new QoderError('quota_identity_unavailable');
 const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);let reader,rejectAbort;
 const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
 const abort=()=>{void reader?.cancel().catch(()=>{});rejectAbort(new QoderError('quota_unavailable'));};
 combined.addEventListener('abort',abort,{once:true});
 const operation=async()=>{
  combined.throwIfAborted();
  const response=await fetchImpl(QUOTA_URL,{method:'GET',redirect:'error',signal:combined,headers:{Accept:'application/json',Authorization:`Bearer ${credential.accessToken}`}});
  if(combined.aborted){void response.body?.cancel().catch(()=>{});throw new QoderError('quota_unavailable');}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new QoderError('quota_unavailable');}
  reader=response.body?.getReader();if(!reader)throw new QoderError('quota_unavailable');
  let size=0;const chunks=[];
  for(;;){combined.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw new QoderError('quota_response_oversized');chunks.push(value);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new QoderError('quota_schema_unavailable');}
  combined.throwIfAborted();return normalizeQuota(data,credential);
 };
 try{return await Promise.race([operation(),aborted]);}
 catch(e){if(e instanceof QoderError)throw e;throw new QoderError('quota_unavailable');}
 finally{combined.removeEventListener('abort',abort);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
}
