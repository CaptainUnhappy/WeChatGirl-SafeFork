import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pluginEnabled} from '../packages/plugin-api/catalog.mjs';
import {createVideoConsole,videoVisionRequest,videoObservation} from './video-console.mjs';

const RETRYABLE_VIDEO_OPEN=new Set(['FOREGROUND_TARGET_CHANGED','FOREGROUND_FOCUS_CHANGED',
  'FOREGROUND_FOCUS_REQUIRED','FOREGROUND_SEARCH_EMPTY','FOREGROUND_VIDEO_TARGET_NOT_UNIQUE',
  'FOREGROUND_VIDEO_TARGET_UNCLICKABLE','VIDEO_DOWNLOAD_QUEUE_EXPIRED','VIDEO_TARGET_NOT_UNIQUE']);

async function readVideo(root,key,id,signal,fetchImpl,waitForCache,onWaiting,onMissing){
  const io=JSON.parse((await fs.readFile(path.join(root,'state/wechat-io-config.json'),'utf8')).replace(/^\uFEFF/,''));
  const base=new URL(io.reader_base_url);
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('VIDEO_READER_UNAVAILABLE');
  const route=base.origin+'/api/v1/videos/'+id+'?conversationKey='+encodeURIComponent(key);
  const headers={Authorization:'Bearer '+io.reader_token};
  const missingUntil=Date.now()+waitForCache;
  let wait=0,reported=false;
  const retry=()=>{
    if(Date.now()>=missingUntil)return false;
    if(!reported){onWaiting();reported=true;}
    wait=Math.min(wait?wait*2:1000,10000,Math.max(1,missingUntil-Date.now()));
    return true;
  };
  while(true){
    if(wait)await delay(wait,undefined,{signal});
    let response;
    try{response=await fetchImpl(route,{headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(25000)])});}
    catch(error){
      signal.throwIfAborted();
      if(retry())continue;
      throw Error('VIDEO_READER_UNAVAILABLE',{cause:error});
    }
    if([404,429,502,503,504].includes(response.status)){
      await response.body?.cancel();
      if(response.status===404)onMissing();
      if(retry())continue;
      if(response.status===404)break;
      throw Error('VIDEO_READER_UNAVAILABLE');
    }
    if(response.status===410){await response.body?.cancel();throw Error('VIDEO_REFERENCE_EXPIRED');}
    if(response.status===401||response.status===403){await response.body?.cancel();throw Error('VIDEO_READER_DENIED');}
    const size=Number(response.headers.get('content-length'));
    if(!response.ok||!response.headers.get('content-type')?.startsWith('application/json')||!Number.isSafeInteger(size)||size<1||size>16384){
      await response.body?.cancel();throw Error('VIDEO_READER_UNAVAILABLE');
    }
    const result=await response.json(),file=result?.localPath;
    if(result?.videoId!==id||result?.conversationKey!==key||typeof file!=='string'||!path.isAbsolute(file)||
      !/[\\/]msg[\\/]video[\\/]\d{4}-\d{2}[\\/][a-f0-9]{32}(?:_raw)?\.mp4$/i.test(file))throw Error('VIDEO_READER_UNAVAILABLE');
    const before=await fs.stat(file).catch(()=>null);
    if(before?.isFile()&&Date.now()-before.mtimeMs>=1500)return file;
    if(!retry())break;
  }
  throw Error('VIDEO_LOCAL_MISSING');
}

export function createIncomingVideo({root,describe,isCurrentAccount,log,requestDownload,fetchImpl=fetch,makeProcessor=createVideoConsole,waitForCache=300000,clickGraceMs=10000}){
  const processVideo=makeProcessor({root,describe:({signal,...input})=>{
    if(!isCurrentAccount())throw Error('VIDEO_ACCOUNT_CHANGED');
    return describe(videoVisionRequest(input),{signal});
  }});
  return async(key,id,signal)=>{
    if(!/^[a-f0-9]{64}$/.test(id)||!isCurrentAccount()||!pluginEnabled(root,'video-workbench',key))return null;
    let downloadIssue='';
    try{
      const deadline=Date.now()+waitForCache;
      let attempts=0,clicks=0,requestPending=false,nextDownloadAt=0;
      const onMissing=()=>{
        const now=Date.now();
        if(requestPending||attempts>=3||!requestDownload||now<nextDownloadAt||now>=deadline||signal.aborted||!isCurrentAccount()||!pluginEnabled(root,'video-workbench',key))return;
        if(attempts&&downloadIssue!=='VIDEO_CLICK_WAITING_FOR_CACHE'&&!RETRYABLE_VIDEO_OPEN.has(downloadIssue))return;
        attempts++;
        requestPending=true;
        void Promise.resolve().then(()=>requestDownload(key,id,clicks)).then(clicked=>{
          if(clicked){
            clicks++;
            nextDownloadAt=Date.now()+clickGraceMs;
          }
          downloadIssue=clicked?'VIDEO_CLICK_WAITING_FOR_CACHE':'';
          log(clicked?'[Video] VIDEO_DOWNLOAD_CLICKED':'[Video] VIDEO_DOWNLOAD_NOT_STARTED');
        }).catch(error=>{
          downloadIssue=/^(?:FOREGROUND|VIDEO|CONVERSATION|API)_[A-Z_0-9]+$/.test(error?.code??'')?error.code:'';
          nextDownloadAt=Date.now()+750;
          log('[Video] VIDEO_DOWNLOAD_NOT_STARTED'+(downloadIssue?' '+downloadIssue:''));
        }).finally(()=>{requestPending=false;});
      };
      const getFile=()=>readVideo(root,key,id,signal,fetchImpl,Math.max(0,deadline-Date.now()),()=>log('[Video] VIDEO_WAITING_FOR_DOWNLOAD'),onMissing);
      let file=await getFile();
      log('[Video] VIDEO_CACHE_READY');
      let result;
      for(let busyRetries=0;!result;){
        if(!isCurrentAccount()||!pluginEnabled(root,'video-workbench',key))return null;
        try{result=await processVideo(null,{key,signal,format:'mp4',action:'recognize',localSource:()=>file});}
        catch(error){
          if(error.code==='VIDEO_CACHE_NOT_READABLE'&&Date.now()<deadline){
            await delay(5000,undefined,{signal});
            file=await getFile();
            continue;
          }
          if(error.code!=='VIDEO_PROCESS_BUSY'||busyRetries++>=29)throw error;
          await delay(2000,undefined,{signal});
        }
      }
      if(!isCurrentAccount()||!pluginEnabled(root,'video-workbench',key))return null;
      log('[Video] VIDEO_RECOGNITION_COMPLETED');
      return videoObservation(result.text.slice(0,600),result.audio);
    }catch(error){
      if(!isCurrentAccount()||!pluginEnabled(root,'video-workbench',key))return null;
      const code=/^VIDEO_[A-Z_]+$/.test(error.message)?error.message:'VIDEO_PROCESS_FAILED';
      log('[Video] '+code);
      if(code==='VIDEO_LOCAL_MISSING'&&['VIDEO_TARGET_NOT_UNIQUE','FOREGROUND_VIDEO_TARGET_NOT_UNIQUE'].includes(downloadIssue)){
        return '已收到视频，但电脑微信里有多条相近的视频，无法自动定位这条。请在电脑微信打开原视频，等下载完成后再发一次。';
      }
      return ({
        VIDEO_LOCAL_MISSING:'等待下载超时。请在 Windows 微信打开视频，等下载完成后再发一次。',
        VIDEO_REFERENCE_EXPIRED:'这条视频来自旧服务或等待太久，原消息引用已失效。请重新发送。',
        VIDEO_READER_DENIED:'视频读取授权已失效，请核对当前微信账号和聊天授权。',
        VIDEO_READER_UNAVAILABLE:'视频读取服务暂不可用，请检查微信读取服务。',
        VIDEO_CACHE_NOT_READABLE:'微信缓存中的视频未下载完整或无法播放，请在 Windows 微信打开视频后重试。',
        VIDEO_MODEL_UNAVAILABLE:'当前识图模型未能解析视频，请在视频插件配置中检查模型。',
      })[code]??'暂时无法识别这个视频。请稍后重试，并确认已导入语音组件。';
    }
  };
}
