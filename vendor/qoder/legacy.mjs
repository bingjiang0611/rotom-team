// Explicit catalog-key inference transport, never a retry fallback or agent loop.
// Protocol reference: 9router d2fd11b11698795a2c4479ef6906304f22162475,
// body.js/chat.js/encoding.js. Copyright (c) 2024-2026 decolua and contributors;
// MIT notice retained in rotom/THIRD_PARTY_NOTICES.md.
import {createHash} from 'node:crypto';
import {catalogHeaders} from './catalog-auth.mjs';
import {QoderError} from './auth.mjs';
export const LEGACY_MODEL_IDS=Object.freeze(['dfmodel','efficient','qmodel_38max','qfmodel','qmodel_latest','kmodel_latest','gfmodel','mmodel','smodel','ultimate']);
export const LEGACY_PATH='/api/v2/service/pro/sse/agent_chat_generation';
export const LEGACY_URL=`https://api2.qoder.sh/algo${LEGACY_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
const standard='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const encoded='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
const fail=code=>{throw new QoderError(code);};
export function encodeBody(text){
  const base=Buffer.from(text).toString('base64'),n=base.length,a=Math.floor(n/3);
  return [...base.slice(n-a)+base.slice(a,n-a)+base.slice(0,a)].map(c=>encoded[standard.indexOf(c)]).join('');
}
export function legacyHeaders(credential,body,modelId='dfmodel'){
  if(!LEGACY_MODEL_IDS.includes(modelId))fail('legacy_model_metadata_required');
  const headers=catalogHeaders(credential),payload=headers.Authorization.slice('Bearer COSY.'.length).split('.')[0];
  const md5=value=>createHash('md5').update(value).digest('hex');
  headers.Authorization=`Bearer COSY.${payload}.${md5(`${payload}\n${headers['Cosy-Key']}\n${headers['Cosy-Date']}\n${body}\n${LEGACY_PATH}`)}`;
  return {...headers,'Cosy-Sigpath':LEGACY_PATH,'Cosy-Bodyhash':md5(body),'Cosy-Bodylength':String(Buffer.byteLength(body)),Accept:'text/event-stream','Content-Type':'application/json','X-Model-Key':modelId,'X-Model-Source':'system'};
}
export function legacyBody(payload,entry,requestId,sessionId,reasoningMode,inputMode){
  if(!LEGACY_MODEL_IDS.includes(payload.model)||entry?.id!==payload.model||!entry.enabled||!entry.reviewed||entry.format!=='openai'||typeof entry.name!=='string'||!Number.isSafeInteger(entry.reportedContextWindow))fail('legacy_model_metadata_required');
  const allowed=['model','messages','tools','tool_choice','stream','stream_options','max_tokens','metadata','enable_thinking','reasoning_effort','temperature','stop'];
  if(Object.keys(payload).some(k=>!allowed.includes(k)))fail('legacy_request_field_unsupported');
  const text=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map(b=>b.text).join('\n'):'';
  const system=payload.messages.filter(m=>m.role==='system').map(text).join('\n');
  if(payload.messages.some(m=>!['system','user','assistant','tool'].includes(m.role)))fail('legacy_request_field_unsupported');
  // The exercised COSY image contract retains both content and contents arrays.
  // Only the transport's reviewed input mode may select it. Text-only assistant
  // tool turns still use an empty string, preserving their native replay fields.
  const messages=payload.messages.filter(m=>m.role!=='system').map(m=>{
    const image=Array.isArray(m.content)&&m.content.some(b=>b.type==='image_url');
    if(image&&!inputMode?.images)fail('images_not_validated');
    return {...m,content:image?m.content:text(m),...image?{contents:m.content}:{}};
  });
  const last=[...messages].reverse().find(m=>m.role==='user');
  const prompt=last?text(last):'';
  // Catalog capability flags are informational, not the selected request mode.
  // Keep all selected mode fields consistent; never replace a requested effort
  // with the historical fixed high default after the provider validated it.
  const reasoning=payload.enable_thinking!==false,effort=payload.reasoning_effort??(reasoning?'high':'none');
  if(!['none','low','medium','high','xhigh','max'].includes(effort)||reasoning!==(effort!=='none'))fail('reasoning_mode_rejected');
  const contextLength=inputMode?.contextLength??Math.min(32000,entry.contextWindow);
  if(!Number.isSafeInteger(contextLength)||contextLength<4096||contextLength>32000&&contextLength!==400000)fail('legacy_model_metadata_required');
  const parameters={max_tokens:payload.max_tokens,reasoning_effort:effort,...reasoningMode?{enable_thinking:reasoning}:{},context_length:contextLength};
  for(const key of ['temperature','stop','tool_choice'])if(payload[key]!==undefined)parameters[key]=payload[key];
  return encodeBody(JSON.stringify({
    request_id:requestId,request_set_id:requestId,chat_record_id:requestId,session_id:sessionId,
    chat_task:'FREE_INPUT',stream:true,is_reply:true,is_retry:false,source:1,version:'3',agent_id:'agent_common',task_id:'common',aliyun_user_type:'',session_type:'qodercli',
    model_config:{key:entry.id,display_name:entry.name,model:'',format:'openai',is_vl:entry.reportedImages,is_reasoning:reasoning,api_key:'',url:'',source:'system',max_input_tokens:entry.reportedContextWindow},
    system,messages,tools:payload.tools??[],parameters,
    chat_context:{text:prompt,features:[],extra:{context:[],modelConfig:{key:entry.id,is_reasoning:reasoning},originalContent:prompt},chatPrompt:'',imageUrls:null},
  }));
}
