import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createVideoConsole} from './video-console.mjs';
import {createIncomingVideo} from './incoming-video.mjs';
import {HookOneBot} from './hook-onebot.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {atomicJson,configuration,updatePlugin,packageFiles,pluginCatalog} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';

const executable=process.env.VIDEO_TEST_FFMPEG;
const key='wechat:private:123';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechatgirl-video-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  atomicJson(path.join(root,'config/wechatagent.json'),{wechat:{whitelist:{private:['123','456'],groups:['123']}},dsh:{provider:'fixture',model:'vision'}});
  const installer=new PluginInstaller(root);
  const preview=installer.inspect({name:'video-workbench.zip',zip:packZip(packageFiles(path.resolve('optional-extensions/video-workbench'))).toString('base64')});
  installer.install(preview);
  installer.dispose();
  const save=(enabled,visionModel={},sampleFrames=4)=>updatePlugin(root,'video-workbench',{revision:configuration(root).revision,enabled,permissions:[],chats:[key,'wechat:group:123'],settings:{resolution:480,quality:30,sampleFrames,visionModel}});
  save(true);
  return {root,save};
}

test('video plugin keeps an all-chats authorization when parameters change',t=>{
  const {root}=fixture(t);
  updatePlugin(root,'video-workbench',{revision:configuration(root).revision,enabled:true,permissions:[],chats:null,settings:{sampleFrames:8,quality:25,resolution:1080,visionModel:{}}});
  const item=pluginCatalog(root).plugins.find(plugin=>plugin.id==='video-workbench');
  assert.equal(item.chats,null);
  assert.equal(item.settings.sampleFrames,8);
});

test('video routes reject wrong formats and chats before running any external tool',async t=>{
  const {root}=fixture(t);
  const handler=createVideoConsole({root,run:()=>assert.fail('FFmpeg should not run')});
  await assert.rejects(handler(Buffer.alloc(16),{action:'compress',format:'mp4',key}),/格式不匹配/);
  const video=Buffer.alloc(16);video.write('ftyp',4);
  await assert.rejects(handler(video,{action:'recognize',format:'mp4',key:'wechat:private:456'}),/授权/);
});

test('queued video download reads the latest selector at dispatch and still rejects another group',async t=>{
  const {root}=fixture(t),id='a'.repeat(64),key='wechat:group:123';
  const hook=Object.create(HookOneBot.prototype);
  const anchor='t:'+'f'.repeat(64);
  let packet={videoId:id,conversationKey:key,talker:'test@chatroom',seconds:18,displaySeconds:[18],onlyVideo:true,before:[anchor,'v'],after:[]};
  let calls=0;
  Object.assign(hook,{directory:root,hook:{wechatExecutable:'Weixin.exe'},reload(){},allowed:()=>true,
    foregroundTarget:async()=>({username:'test@chatroom',displayName:'Test group'}),
    reader:async()=>packet,foreground:{send:async(prepare)=>{
      packet={...packet,onlyVideo:false};
      const body=await prepare();
      calls++;
      assert.deepEqual([body.videoSeconds,body.displaySeconds,body.onlyVideo,body.previousClicks,body.videoBefore],[18,[18],false,1,[anchor,'v']]);
      return {accepted:true};
    }}});
  assert.deepEqual(await hook.openVideo('group','123',id,1),{clicked:true});
  hook.reader=async()=>{throw Error('API_HTTP_409');};
  await assert.rejects(hook.openVideo('group','123',id),/VIDEO_TARGET_NOT_UNIQUE/);
  hook.reader=async()=>({...packet,talker:'other@chatroom'});
  await assert.rejects(hook.openVideo('group','123',id),/VIDEO_TARGET_MISMATCH/);
  assert.equal(calls,1);
});

test('a group can reply to a mention while video downloads, then reply as its persona', {timeout:5000},async t=>{
  const {root}=fixture(t),groupKey='wechat:group:123',videoId='a'.repeat(64);
  const buffer=new MessageBuffer(path.join(root,'queue.json'));
  const download=Promise.withResolvers();
  const started=Promise.withResolvers();
  const textSent=Promise.withResolvers();
  const videoSent=Promise.withResolvers();
  const requests=[];
  const connection={epoch:1,instanceId:'same-dsh',check:async()=>true,skips:()=>false,metadata:()=>({}),current(epoch){return epoch===this.epoch;}};
  const engine=new SocialEngine({buffer,videoAccess:key=>key===groupKey?'enabled':null,modeFor:()=> 'mention',
    connection,roleFor:()=> '人格卡测试语气',batchMs:5,minIntervalMs:1,
    recognizeVideo:()=>{started.resolve();return download.promise;},
    decide:async(_key,prompt,metadata)=>{
      requests.push({prompt,persona:metadata.persona});
      return prompt.includes('画面有小狗')?'RESPOND：狗狗在看镜头':'RESPOND：文字已收到';
    },send:async(message,text)=>{
      if(message.waitForVideoReceipt)videoSent.resolve({message,text});
      else textSent.resolve(text);
      return {delivered:'database-confirmed'};
    }});
  t.after(()=>engine.stop());
  const event=(id,segments)=>normalizeOneBotEvent('wechat','fixture',{post_type:'message',message_type:'group',group_id:123,user_id:789,self_id:456,message_id:id,message:segments});
  const video=event(1,[{type:'video',data:{file:'wechatagent://video/'+videoId,media_id:videoId}}]);
  engine.receive(video);
  await started.promise;
  engine.receive(event(2,[{type:'at',data:{qq:'456'}},{type:'text',data:{text:'测试视频下载时仍能聊天'}}]));
  assert.match(await textSent.promise,/文字已收到/);
  assert.equal(requests.length,1);
  connection.epoch++;
  download.resolve('画面有小狗。对白说看镜头。');
  const reply=await videoSent.promise;
  assert.equal(String(reply.message.conversation_id),'123');
  assert.equal(reply.message.sender_id,'789');
  assert.match(reply.text,/狗狗在看镜头/);
  assert.equal(requests.length,2);
  assert.equal(requests[1].persona,'人格卡测试语气');
  assert.match(requests[1].prompt,/当前人格卡/);
  assert.match(requests[1].prompt,/对白说看镜头/);
});

test('video download retries a temporary failure and a click without a cache file',{timeout:11000},async t=>{
  const {root}=fixture(t),id='b'.repeat(64);
  const file=path.join(root,'msg','video','2026-11','a'.repeat(32)+'.mp4');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'fixture');
  fs.utimesSync(file,new Date(),new Date(Date.now()-3000));
  atomicJson(path.join(root,'state/wechat-io-config.json'),{reader_base_url:'http://127.0.0.1:5031/',reader_token:'fixture'});
  let opens=0;
  const stages=[];
  const recognize=createIncomingVideo({root,isCurrentAccount:()=>true,log:line=>stages.push(line),waitForCache:9500,clickGraceMs:20,
    requestDownload:async(_key,_id,clicks)=>{
      if(++opens===1)throw Object.assign(new Error('temporarily changing chats'),{code:'FOREGROUND_TARGET_CHANGED'});
      assert.equal(clicks,opens-2);
      return true;
    },fetchImpl:async()=>{
      if(opens<3)return new Response(null,{status:404});
      const body=JSON.stringify({videoId:id,conversationKey:key,localPath:file});
      return new Response(body,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}});
    },makeProcessor:()=>async(_data,{localSource})=>{
      assert.equal(localSource(),file);
      return {text:'视频已读取'};
    }});
  assert.match(await recognize(key,id,AbortSignal.timeout(10000)),/视频已读取/);
  assert.equal(opens,3);
  assert(stages.indexOf('[Video] VIDEO_CACHE_READY')>stages.lastIndexOf('[Video] VIDEO_DOWNLOAD_CLICKED'));
});

test('real FFmpeg compresses a video and sends only the JPEG sheet to the recognition callback',{skip:!executable},async t=>{
  const {root,save}=fixture(t),source=path.join(root,'sample.mp4');
  save(true,{provider:'alternate',model:'video-vision'},5);
  execFileSync(executable,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=25',
    '-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-preset','ultrafast','-crf','16','-c:a','aac',source],{windowsHide:true,timeout:20000});
  const bytes=fs.readFileSync(source);
  let called=0;
  const handler=createVideoConsole({root,executable,asrReady:()=>true,transcribe:async(_root,audio)=>{
    assert.equal(fs.readFileSync(audio.path).subarray(0,4).toString(),'RIFF');
    return '本机测试对白';
  },describe:async payload=>{
    called++;
    assert.deepEqual(payload.video,{seconds:2,frames:5});
    assert.equal(payload.mime,'image/jpeg');
    const jpeg=Buffer.from(payload.b64,'base64');
    assert(jpeg[0]===255&&jpeg[1]===216);
    assert.equal(payload.selection.model,'vision');
    assert.deepEqual(payload.parser,{provider:'alternate',model:'video-vision'});
    return {text:'测试图案',parserModel:{provider:'fixture',model:'vision'}};
  }});
  const compressed=await handler(bytes,{action:'compress',format:'mp4',key});
  assert(compressed.smaller);assert.equal(called,0);
  assert.equal(Buffer.from(compressed.video,'base64').subarray(4,8).toString(),'ftyp');
  const recognized=await handler(bytes,{action:'recognize',format:'mp4',key});
  assert.equal(recognized.text,'测试图案');assert.equal(called,1);
  assert.deepEqual(recognized.audio,{status:'ready',text:'本机测试对白'});

  atomicJson(path.join(root,'state/wechat-io-config.json'),{reader_base_url:'http://127.0.0.1:4567',reader_token:'fixture'});
  const id='a'.repeat(64);
  const groupKey='wechat:group:123';
  const large=path.join(root,'msg','video','2026-11','a'.repeat(32)+'.mp4');
  fs.mkdirSync(path.dirname(large),{recursive:true});
  execFileSync(executable,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=2','-f','lavfi','-i','sine=frequency=440',
    '-t','185','-c:v','libx264','-preset','ultrafast','-c:a','aac','-movflags','+faststart',large],{windowsHide:true,timeout:20000});
  const padding=33*1024*1024;
  const originalSize=fs.statSync(large).size;
  const free=Buffer.alloc(8);
  free.writeUInt32BE(padding);
  free.write('free',4);
  fs.appendFileSync(large,free);
  fs.truncateSync(large,originalSize+padding);
  const cachedAt=new Date(Date.now()-5000);
  fs.utimesSync(large,cachedAt,cachedAt);
  let reads=0;
  let describes=0;
  let requested=0;
  const recognize=createIncomingVideo({root,isCurrentAccount:()=>true,log:()=>{},
    requestDownload:async(chat,idToOpen)=>{assert.equal(chat,groupKey);assert.equal(idToOpen,id);requested++;return true;},
    makeProcessor:options=>createVideoConsole({...options,executable,asrReady:()=>true,transcribe:async(_root,audio)=>{
      const wav=fs.readFileSync(audio.path);
      assert(wav.length>5900000&&wav.length<5940000,'expected all 185 seconds of audio');
      return '群聊测试对白';
    }}),
    fetchImpl:async(url,options)=>{
      reads++;
      assert.equal(new URL(url).pathname,'/api/v1/videos/'+id);
      assert.equal(new URL(url).searchParams.get('conversationKey'),groupKey);
      assert.equal(options.headers.Authorization,'Bearer fixture');
      if(reads===1)return new Response(null,{status:404});
      if(reads===2)return new Response(null,{status:503});
      const body=JSON.stringify({videoId:id,conversationKey:groupKey,localPath:large});
      return new Response(body,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(body))}});
    },
    describe:async input=>{
      describes++;
      assert.deepEqual(input.video,{seconds:185,frames:5});
      assert.equal(input.mode,'parser');
      assert.deepEqual(input.selection,{provider:'alternate',model:'video-vision'});
      assert.equal(Buffer.from(input.b64,'base64').subarray(0,3).toString('hex'),'ffd8ff');
      return {text:'抽样画面中有色块 <test>'};
    }});
  const signal=AbortSignal.timeout(10000);
  assert.equal(await recognize('wechat:private:456',id,signal),null);
  assert.equal(reads,0);
  const message=normalizeOneBotEvent('wechat','fixture',{post_type:'message',message_type:'group',group_id:123,user_id:789,self_id:456,message_id:1,
    message:[{type:'video',data:{file:'wechatagent://video/'+id,media_id:id}}]});
  assert.equal(message.videoId,id);
  assert.equal(normalizeOneBotEvent('wechat','fixture',{...message.raw,message:[{type:'video',data:{file:'https://example.com/test.mp4',media_id:id}}]}).videoId,undefined);
  const adapter=new WechatOneBotAdapter();
  const buffer=new MessageBuffer(path.join(root,'messages.json'));
  let sendAttempts=0;
  let engine;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('chat did not reply')),12000);
    t.after(()=>clearTimeout(timeout));
    engine=new SocialEngine({buffer,recognizeVideo:recognize,videoAccess:key=>key===groupKey?configuration(root).revision:null,modeFor:()=> 'mention',batchMs:5,
      decide:async(_key,prompt,metadata)=>{
        if(!prompt.includes('抽样画面中有色块 &lt;test&gt;'))reject(Error('video observation missing from chat prompt'));
        if(!prompt.includes('整段音轨转写：群聊测试对白'))reject(Error('audio transcript missing from chat prompt'));
        if(metadata.groupEngagement.direct!==true)reject(Error('video reply remains subject to ambient group sampling'));
        return 'SILENT';
      },deliveryRetry:{receiptDelayMs:5},send:async(_message,text,options)=>{
        if(!text.includes('群聊测试对白'))return reject(Error('video summary must still be sent after model silence'));
        sendAttempts++;
        if(sendAttempts===1){
          if(options.receiptOnly)return reject(Error('initial submission must send text'));
          return {delivered:'unconfirmed'};
        }
        if(!options.receiptOnly)return reject(Error('ambiguous delivery must only check receipt'));
        clearTimeout(timeout);resolve();
        return {delivered:'database-confirmed'};
      }});
    t.after(()=>engine.stop());
    engine.receive({...message,conversation_id:'456',message_id:'unauthorized'});
    adapter.on('message',value=>engine.receive(value));
    adapter.server.emit('event',message.raw);
  });
  assert.equal(reads,3);
  assert.equal(requested,1);
  assert.equal(describes,1);
  assert.equal(sendAttempts,2);
});
