import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {configuration,scanPlugins} from '../packages/plugin-api/catalog.mjs';
import {validModelId} from '../packages/dsh-social-bridge-plugin/model-routing.mjs';
import {senseVoiceReady,transcribeSenseVoiceFile} from '../packages/plugin-api/sensevoice.mjs';

const exec=promisify(execFile);
export const VIDEO_INPUT_LIMIT=32*1024*1024;
const OUTPUT_LIMIT=24*1024*1024;
const MAX_SECONDS=180;
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const formats={mp4:'mov',mov:'mov',m4v:'mov',webm:'matroska',mkv:'matroska'};
const ffmpegArgs=['-hide_banner','-nostdin','-protocol_whitelist','file','-max_alloc','134217728'];
const readConfig=async root=>JSON.parse((await fs.readFile(path.join(root,'config/wechatagent.json'),'utf8')).replace(/^\uFEFF/,''));

function checkedFormat(format,bytes){
  if(!Object.hasOwn(formats,format)||bytes.length<16||bytes.length>VIDEO_INPUT_LIMIT)throw fault('请选择 32 MB 以内的 MP4、MOV、M4V、WebM 或 MKV 视频。');
  const mov=formats[format]==='mov';
  if(mov?bytes.subarray(4,8).toString()!=='ftyp':!bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))throw fault('文件内容与视频格式不匹配。请先用播放器打开原视频检查。');
  return mov?['-f','mov','-enable_drefs','0']:['-f','matroska'];
}

function metadata(log,chatVideo){
  const input=log.split('Output #')[0];
  const duration=/Duration: (\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(input);
  const stream=input.split('\n').find(line=>/Stream #\d+:\d+.*Video:/.test(line)&&!/attached pic/i.test(line));
  const size=stream?.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const seconds=duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):0;
  if(!size||!seconds)throw fault('无法核对视频轨道或时长。请尝试重新导出为标准 MP4。');
  if(!chatVideo&&(seconds>MAX_SECONDS||Number(size[1])*Number(size[2])>4096*2160))throw fault('视频需在 3 分钟以内，画面分辨率最高约为 4K。请先截取所需片段。');
  return {seconds,width:Number(size[1]),height:Number(size[2]),hasAudio:/Stream #\d+:\d+.*Audio:/.test(input)};
}

async function videoTranscript({root,info,inputArgs,input,folder,invoke,signal,transcribe,asrReady}){
  if(!info.hasAudio)return {status:'no_audio'};
  if(!asrReady(root))return {status:'missing_model'};
  if(info.seconds>300)return {status:'too_long'};
  try{
    const output=path.join(folder,'speech.wav');
    await invoke(['-loglevel','error',...inputArgs,'-threads','2','-i',input,'-map','0:a:0',
      '-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',output],45000);
    const text=await transcribe(root,{path:output},{signal});
    return {status:'ready',text};
  }catch(error){
    if(signal?.aborted)throw signal.reason;
    return {status:error.code==='VOICE_API_EMPTY_TRANSCRIPT'?'no_speech':'failed'};
  }
}

export function videoObservation(text,audio){
  const label={no_audio:'视频无音轨。',missing_model:'本机 SenseVoice 未安装，暂只分析画面。',no_speech:'未转写到清楚的对白。',too_long:'视频超过 5 分钟，本次只分析画面。',failed:'整段音轨转写失败，本次只分析画面。'}[audio?.status];
  const speech=audio?.status==='ready'?'\n整段音轨转写：'+audio.text:label?'\n'+label:'';
  return '画面抽样：'+text+speech;
}

async function pluginSettings(root,key){
  const project=await readConfig(root);
  const match=/^wechat:(private|group):([1-9]\d{0,15})$/.exec(key??'');
  const allowed=match&&project.wechat?.whitelist?.[match[1]==='group'?'groups':'private']?.some(id=>String(id)===match[2]);
  const saved=configuration(root);
  const record=saved.config.plugins['video-workbench'];
  const item=scanPlugins(root).find(plugin=>plugin.id==='video-workbench'&&!plugin.invalid);
  if(!item||!record?.enabled)throw fault('请先安装并启用视频处理插件。',403);
  if(!allowed||record.chats!==null&&!record.chats?.includes(key))throw fault('请在“插件与聊天”授权所选聊天使用视频处理。',403);
  const settings={...item.settings,...record.settings};
  const selection={...project.dsh,...project.dsh?.chats?.[key]};
  const visionFallback=project.dsh?.visionFallback;
  return {settings,selection,visionFallback,revision:JSON.stringify([saved.revision,item.revision,selection,visionFallback])};
}

export function videoVisionRequest({b64,mime,video,selection,parser,visionFallback}){
  return {b64,mime,video,mode:parser?'parser':'route',
    chatSelection:{provider:selection?.provider,model:selection?.model},
    selection:parser??visionFallback?.selection??null,enabled:visionFallback?.enabled!==false};
}

export function createVideoConsole({root,describe,executable=path.join(root,'state/voice/tools/ffmpeg.exe'),run=exec,transcribe=transcribeSenseVoiceFile,asrReady=senseVoiceReady}){
  let busy=false;
  return async function processVideo(bytes,{action,format,key,signal,localSource}){
    if(!['compress','recognize'].includes(action))throw fault('请选择压缩或识别。');
    const chatVideo=typeof localSource==='function'&&action==='recognize'&&format==='mp4';
    let inputArgs=chatVideo?null:checkedFormat(format,bytes);
    if(busy)throw Object.assign(fault('已有视频正在处理，请稍后再试。',409),{code:'VIDEO_PROCESS_BUSY'});
    busy=true;
    let folder;
    try{
      const initial=await pluginSettings(root,key);
      const recheck=async()=>{signal?.throwIfAborted();if((await pluginSettings(root,key)).revision!==initial.revision)throw fault('视频插件设置或聊天权限已变化，请重新处理。',409);};
      if(!await fs.stat(executable).then(stat=>stat.isFile(),()=>false))throw fault('缺少本机 FFmpeg。请在语音音色页导入语音组件后重试。',503);
      await recheck();
      folder=await fs.mkdtemp(path.join(os.tmpdir(),'wechatgirl-video-'));
      const input=chatVideo?await localSource():path.join(folder,'source.'+format);
      if(chatVideo){
        const header=Buffer.alloc(16),source=await fs.open(input,'r');
        try{if((await source.read(header,0,header.length,0)).bytesRead!==header.length)throw fault('视频文件尚未下载完整。');}
        finally{await source.close();}
        inputArgs=checkedFormat(format,header);
      }else await fs.writeFile(input,bytes,{flag:'wx',mode:0o600,signal});
      await recheck();
      const invoke=async(args,timeout)=>{
        try{return await run(executable,[...ffmpegArgs,...args],{cwd:folder,timeout,signal,windowsHide:true,maxBuffer:256*1024});}
        catch(error){if(signal?.aborted)throw signal.reason;throw fault(error.killed?'本机视频处理超时。请缩短片段或降低分辨率。':'FFmpeg 无法解码或处理视频。请检查原文件，或重新导出为标准 MP4。');}
      };
      const videoInput=[...inputArgs,'-threads','2','-i',input];
      let probe;
      try{probe=await invoke([...videoInput,'-map','0:V:0','-c:v','copy','-t','0','-f','null','-'],15000);}
      catch(error){
        if(!chatVideo||signal?.aborted)throw error;
        throw Object.assign(error,{code:'VIDEO_CACHE_NOT_READABLE'});
      }
      const info=metadata(probe.stderr,chatVideo);
      await recheck();
      const {settings}=initial;
      if(action==='compress'){
        const height=[480,720,1080].includes(settings.resolution)?settings.resolution:720;
        const output=path.join(folder,'compressed.mp4');
        const bitrate=Math.max(180,Math.min(2400,Math.floor(19*1024*1024*8/info.seconds/1000)-96));
        await invoke(['-loglevel','error',...videoInput,'-map','0:V:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1',
          '-vf',`scale=w='min(iw,${height*16/9})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
          '-fpsmax','30','-c:v','libx264','-pix_fmt','yuv420p','-preset','fast','-crf',String(Number.isSafeInteger(settings.quality)&&settings.quality>=20&&settings.quality<=34?settings.quality:26),
          '-maxrate',bitrate+'k','-bufsize',bitrate*2+'k','-threads','2','-c:a','aac','-b:a','96k','-movflags','+faststart',output],85000);
        await recheck();
        const size=(await fs.stat(output)).size;
        if(!size||size>OUTPUT_LIMIT)throw fault('压缩结果超出 24 MB，请降低分辨率或缩短片段。');
        return {...info,sourceBytes:bytes.length,size,smaller:size<bytes.length,video:(await fs.readFile(output)).toString('base64')};
      }
      const parser=settings.visionModel;
      const explicit=parser&&Object.keys(parser).length>0;
      if(explicit&&(!validModelId(parser.provider)||!validModelId(parser.model)))throw fault('请重新选择视频识别模型，或选择跟随聊天与图片分流。');
      const frames=Number.isSafeInteger(settings.sampleFrames)&&settings.sampleFrames>=2&&settings.sampleFrames<=16?settings.sampleFrames:6;
      const columns=frames>8?4:2;
      const tile=`tile=${columns}x${Math.ceil(frames/columns)}:nb_frames=${frames}`;
      const output=path.join(folder,'frames.jpg');
      const scale='scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2';
      if(chatVideo){
        const frame=path.join(folder,'sample-%02d.jpg');
        for(let index=0;index<frames;index++){
          const seconds=(info.seconds*(index+.5)/frames).toFixed(3);
          await invoke(['-loglevel','error','-ss',seconds,...videoInput,'-map','0:V:0','-an','-vf',scale,
            '-frames:v','1','-threads','1','-q:v','4',frame.replace('%02d',String(index).padStart(2,'0'))],10000);
        }
        await invoke(['-loglevel','error','-f','image2','-start_number','0','-i',frame,'-vf',tile,
          '-frames:v','1','-threads','1','-q:v','4',output],10000);
      }else{
        await invoke(['-loglevel','error',...videoInput,'-map','0:V:0','-an','-vf',
          `fps=${frames}/${info.seconds}:round=up,${scale},${tile}`,
          '-frames:v','1','-threads','1','-q:v','4',output],35000);
      }
      await recheck();
      const image=await fs.readFile(output);
      if(image.length>768*1024)throw fault('抽帧结果过大，请减少抽帧数量。');
      // Wait for both tasks before deleting temporary files, including on cancellation.
      const [visual,audio]=await Promise.allSettled([
        describe({b64:image.toString('base64'),mime:'image/jpeg',video:{seconds:info.seconds,frames},selection:initial.selection,visionFallback:initial.visionFallback,...(explicit?{parser}:{}),signal}),
        videoTranscript({root,info,inputArgs,input,folder,invoke,signal,transcribe,asrReady}),
      ]);
      if(visual.status==='rejected')throw visual.reason;
      if(audio.status==='rejected')throw audio.reason;
      await recheck();
      const result=visual.value;
      return {...info,frames,text:result.text,audio:audio.value,model:result.parserModel};
    }finally{
      if(folder)await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});
      busy=false;
    }
  };
}
