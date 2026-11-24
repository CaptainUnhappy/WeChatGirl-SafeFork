import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedTask} from './deadline.mjs';

export async function imageBlocks(ctx,root,conversationKey,images,provider,model,{onUnavailable,timeoutMs=65000,signal:parentSignal,fallback,fetchImpl=fetch,thumbnailWaitMs=1200}={}) {
  if (!Array.isArray(images) || images.length>4) throw new Error('IMAGE_BATCH_LIMIT');
  if (!images.length) return [];
  if (images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id ?? ''))) throw new Error('INVALID_IMAGE_REFERENCE');
  const llm=ctx.get('llm'), attachments=ctx.get('attachments');
  if (!llm || !attachments) throw new Error('NATIVE_IMAGE_SERVICES_UNAVAILABLE');
  const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(parentSignal?[parentSignal]:[])]);
  const unavailableBlock=(image,index,error)=>{
    if(!onUnavailable)throw error;
    // Reject the image itself on binding/integrity/format failures too. Never
    // admit its bytes, and never leave that bad input at the head of the chat.
    const safeCode=/^(?:(?:IMAGE|VISION)_[A-Z_]+|INVALID_IMAGE_DATA|MODEL_IMAGE_INPUT_UNSUPPORTED)$/.test(error.message)?error.message:'IMAGE_READER_NOT_READY';
    const code=error.imageError??(error.name==='TimeoutError'||error.name==='AbortError'?'IMAGE_PROCESS_TIMEOUT':safeCode);
    onUnavailable({id:image.id,index,code});
    const reason={
      IMAGE_LOCAL_COPY_UNAVAILABLE:'电脑微信未缓存可读取的图片。请在电脑微信打开图片，或请发送方选择原图重发。',
      MODEL_IMAGE_INPUT_UNSUPPORTED:'当前聊天模型不支持看图，且没有可用的备用识图模型。',
      VISION_SELECTED_MODEL_UNSUPPORTED:'所选备用模型不支持图片输入，请重新选择。',
      VISION_MODEL_UNAVAILABLE:'没有找到可用的备用识图模型，请在设置中选择并测试。',
      VISION_PARSE_TIMEOUT:'识图模型处理超时，未能取得解析结果。',
      VISION_FALLBACK_DISABLED:'当前模型不能看图，图片分流未开启。',
      IMAGE_PROCESS_TIMEOUT:'读取图片超时，图片清晰度无法判断。',
    }[code]??'当前没有取得图片，无法判断清晰度。';
    return {type:'text',text:`[本轮附图 I${index+1} 没有可用画面。${reason}回复只说明实际障碍，不判断未收到图片的清晰度。其余成功附图仍可使用。]`};
  };
  let info;
  try{info=await boundedTask(s=>llm.resolveModelInfo(provider,model,s),{timeoutMs:Math.min(timeoutMs,8000),signal});}
  catch(error){return images.map((image,index)=>unavailableBlock(image,index,error));}
  const needsFallback=!info.inputModalities?.includes('image');
  if(needsFallback&&typeof fallback?.describe!=='function')return images.map((image,index)=>unavailableBlock(image,index,new Error('MODEL_IMAGE_INPUT_UNSUPPORTED')));
  const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,''));
  const base=new URL(io.reader_base_url);
  if (base.protocol!=='http:' || base.hostname!=='127.0.0.1' || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('IMAGE_READER_LOOPBACK_REQUIRED');
  const blocks=new Array(images.length);let next=0;
  async function readImage(image,taskSignal){
    const response=await fetchImpl(base.origin+'/api/v1/images/'+image.id,{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal:taskSignal});
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error('IMAGE_READER_NOT_READY');
      if (typeof failure.error === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(failure.error)) error.imageError = failure.error;
      throw error;
    }
    const content=await response.json();
    if (content.imageId!==image.id || content.conversationKey!==conversationKey) throw new Error('IMAGE_CONVERSATION_MISMATCH');
    if (typeof content.b64!=='string' || content.b64.length>1100000 || !['image/png','image/jpeg','image/webp'].includes(content.mime)) throw new Error('INVALID_IMAGE_DATA');
    const data=Buffer.from(content.b64,'base64');
    if (!data.length || data.length>768*1024 || data.toString('base64')!==content.b64 || crypto.createHash('sha256').update(data).digest('hex')!==content.sha256) throw new Error('IMAGE_INTEGRITY_FAILED');
    return {...content,data};
  }
  async function prepare(image,index) {
    try {
    return await boundedTask(async taskSignal=>{
    let content=await readImage(image,taskSignal);
    if(content.sourceQuality==='thumbnail'){
      try{
        await delay(thumbnailWaitMs,undefined,{signal:taskSignal});
        const refreshed=await boundedTask(retrySignal=>readImage(image,retrySignal),{timeoutMs:2400,signal:taskSignal});
        if(refreshed.sourceQuality==='full')content=refreshed;
      }catch(error){if(taskSignal.aborted)throw error;}
    }
    const {data}=content;
    const size=[content.width,content.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)?'，送入画面的尺寸 '+content.width+'×'+content.height+' 像素':'';
    const sourceNote=content.sourceQuality==='thumbnail'?'当前是微信缓存的预览图'+size+'。请照常说明确实可辨认的内容；只标明看不清的具体细节。若所问细节确实不可辨认，再请发送方选择原图重发。':'';
    if(needsFallback){
      const description=await fallback.describe({key:conversationKey,id:image.id,index,data,mime:content.mime,sourceQuality:content.sourceQuality,preferred:{provider,model},signal:taskSignal});
      const safe=String(description).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return {type:'text',text:`[图片 I${index+1} 的独立解析结果，仅作为本轮参考。${sourceNote}\n${safe}]`};
    }
    const attachment=await attachments.saveImage({data,mediaType:content.mime,name:'wechat-image-'+image.id.slice(0,12)});
    const block={type:'image',attachment};
    return content.sourceQuality==='thumbnail' ? [
      {type:'text',text:`[附图 I${index+1}：${sourceNote}]`},block,
    ] : block;
    },{timeoutMs:needsFallback?63000:16000,signal});
    } catch(error) {
      return unavailableBlock(image,index,error);
    }
  }
  await Promise.all(Array.from({length:Math.min(2,images.length)},async()=>{
    while(next<images.length){const index=next++;blocks[index]=await prepare(images[index],index);}
  }));
  return blocks.flat();
}

export function offloadCompletedImages(session,sourceSeqs) {
  const targets=[];
  for (const seq of sourceSeqs) {
    const event=session.eventAt(seq);
    const message=session.deriveEventMessage ? session.deriveEventMessage(event) : event.data;
    const imageIndexes=[];let index=0;
    for (const block of message.content ?? []) if(block.type==='image'){if(!block.offloaded)imageIndexes.push(index);index++;}
    if (imageIndexes.length) targets.push({seq,imageIndexes});
  }
  if(targets.length) session.append('image/offload',{targets});
}

export function offloadCompletedSessionImages(session) {
  // Failed/cancelled vision turns must release their image bytes too. Keeping
  // an invalid attachment active makes every later text request fail again.
  const completed=session.snapshotEvents().findLast(event=>event.type==='turn/end');
  if(!completed)return;
  const seqs=session.surface.nodes.filter(seq=>{
    const event=session.eventAt(seq);
    return seq<completed.seq && event.type==='user/message' && event.data.source?.socialImageIds?.length;
  });
  offloadCompletedImages(session,seqs);
}
