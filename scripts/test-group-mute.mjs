import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GroupMute,groupMuted,suppressedGroupJob,groupMuteCommand} from '../packages/plugin-api/group-mute.mjs';
import {atomicJson,configuration,packageFiles,updatePlugin} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {HookOneBot,onebotId} from './hook-onebot.mjs';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';

const key='wechat:group:123',account='a'.repeat(64);
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-group-mute-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const wechat={whitelist:{groups:['123','456'],private:['789']},assistant:{administrators:['wxid_admin']}};
  atomicJson(path.join(root,'config/wechatagent.json'),{wechat});
  atomicJson(path.join(root,'state/weflow/active-account.json'),{id:account});
  const installer=new PluginInstaller(root);
  installer.install(installer.inspect({name:'group-mute.zip',zip:packZip(packageFiles(path.resolve('optional-extensions/group-mute'))).toString('base64')}));
  installer.dispose();
  const save=(settings={},chats=[key])=>updatePlugin(root,'group-mute',{revision:configuration(root).revision,enabled:true,chats,permissions:[],settings:{useAssistantAdministrators:true,extraOperators:[],defaultMinutes:15,maxMinutes:120,...settings}});
  save();
  return {root,wechat,save};
}
function command(text,id,sender='wxid_admin',now=Date.now()){
  return {platform:'wechat',kind:'group',conversation_id:'123',sender_wxid:sender,sender_id:onebotId(sender),message_id:id,timestamp:now/1000,text};
}

test('a WeChat mention around the command survives reader and OneBot delivery',t=>{
  const {root,wechat}=fixture(t);
  const adapter=Object.assign(Object.create(HookOneBot.prototype),{
    ownWxid:'wxid_bot',project:{account:{nicknames:['小鱼']}},reload(){},allowed:()=>true,
  });
  const receive=(content,rawid,sender='wxid_admin')=>normalizeOneBotEvent('wechat','wechat-onebot',adapter.incoming({
    event:'message.new',sessionId:'demo@chatroom',conversationId:123,talkerId:sender,type:1,content,rawid,
  }));
  const now=Date.now();
  const controller=new GroupMute({root,account,settingsFor:()=>wechat,now:()=>now});
  assert.equal(groupMuteCommand(receive('@其他人\u2005闭嘴30分钟','other-target')),null);
  assert.equal(groupMuteCommand(receive('@小鱼\u2005帮我闭嘴30分钟','ordinary-text')),null);
  assert(controller.handle(key,receive('@小鱼\u2005闭嘴30分钟','denied','wxid_member')));
  assert(!groupMuted(root,key,now));
  const message=receive('@小鱼\u2005闭嘴30分钟','mute');
  assert.equal(message.text,'@小鱼\u2005闭嘴30分钟');
  assert(controller.handle(key,message));
  assert.equal(controller.state(key).until,now+30*60000);
  assert(controller.handle(key,receive('解除闭嘴 @小鱼','resume')));
  assert(!groupMuted(root,key,now));
});

test('only permitted identities can mute, and the resumed persona notice is submitted once across restarts',async t=>{
  const {root,wechat,save}=fixture(t);let now=Date.now(),ready=false;const sent=[];
  const options={root,account,settingsFor:()=>wechat,now:()=>now,isReady:()=>ready,generate:async()=> '小鱼回来啦！',send:async(...args)=>sent.push(args)};
  const controller=new GroupMute(options);
  assert(controller.handle(key,command('闭嘴 30分钟','unauthorized','wxid_other',now)));
  assert(!groupMuted(root,key,now));
  assert(controller.handle(key,{...command('闭嘴','spoof','wxid_admin',now),sender_id:123}));
  assert(!groupMuted(root,key,now));
  assert.equal(groupMuteCommand({...command('闭嘴','quote'),quoteReply:{}}),null);
  save({useAssistantAdministrators:false,extraOperators:['wxid_delegate'],maxMinutes:30});
  assert(controller.handle(key,command('闭嘴','retired','wxid_admin',now)));
  assert(!groupMuted(root,key,now));
  assert(controller.handle(key,command('闭嘴 1小时','too-long','wxid_delegate',now)));
  assert(!groupMuted(root,key,now));
  const request=command('闭嘴 30分钟','authorized','wxid_delegate',now);
  assert(controller.handle(key,request));
  assert(groupMuted(root,key,now));
  assert(!groupMuted(root,'wechat:group:456',now));
  assert(suppressedGroupJob(root,key,now-5));
  const until=controller.state(key).until;
  now+=10000;controller.handle(key,request);
  assert.equal(controller.state(key).until,until);
  controller.handle(key,command('解除闭嘴','denied-unmute','wxid_admin',now));
  assert(groupMuted(root,key,now));
  controller.handle(key,command('开麦','unmute','wxid_delegate',now));
  assert(!groupMuted(root,key,now));
  await controller.tick();assert.equal(sent.length,0);
  ready=true;
  const restarted=new GroupMute(options);
  await restarted.tick();await restarted.tick();await new GroupMute(options).tick();
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].slice(0,2),[key,'小鱼回来啦！']);
  assert.match(sent[0][2],/^[a-f0-9]{64}$/);
  now+=1000;
  assert(controller.handle(key,command('闭嘴 1分钟','next','wxid_delegate',now)));
  now+=60000;await restarted.tick();
  assert.equal(sent.length,2);
});

test('a mute blocks outgoing text and stickers, and invalidates an in-progress model reply',async t=>{
  const {root,wechat}=fixture(t);
  const buffer=new MessageBuffer(path.join(root,'buffer.json'));
  const workStarted=Promise.withResolvers(),finishWork=Promise.withResolvers();
  const outputs=[];let turns=0;
  const controller=new GroupMute({root,account,settingsFor:()=>wechat,onMute:key=>engine.muteChat(key)});
  const engine=new SocialEngine({buffer,batchMs:5,modeFor:()=> 'hybrid',muteStateFor:key=>controller.state(key),
    decide:async()=>{turns++;workStarted.resolve();return finishWork.promise;},send:async(_message,text)=>outputs.push(text)});
  t.after(()=>engine.stop());
  engine.receive(command('正在处理的消息','incoming'));
  await workStarted.promise;
  controller.handle(key,command('闭嘴','mute'));
  const adapter=Object.assign(Object.create(HookOneBot.prototype),{directory:root});
  await assert.rejects(adapter.send('group','123','不应该发出'),/GROUP_MUTED/);
  await assert.rejects(adapter.sendSticker('group','123','not-sent'),/GROUP_MUTED/);
  engine.receive(command('暂停期间收到的消息','muted'));
  controller.handle(key,command('开麦','resume'));
  finishWork.resolve('RESPOND: 不应补发');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(turns,1);
  assert.deepEqual(outputs,[]);
  assert.equal(buffer.unread(key).length,0);
});

test('tier one admits only a verified self-mention; tier two survives restart and only the exact authorized unlock works',async t=>{
  const {root,wechat,save}=fixture(t);save({defaultMode:'二档 · 完全静音'});
  let now=Date.now();const outputs=[],notices=[],decisions=[];
  const buffer=new MessageBuffer(path.join(root,'buffer.json'));
  const opts={root,account,settingsFor:()=>wechat,now:()=>now,onMute:key=>engine.muteChat(key),generate:async()=> '我回来啦',send:async(...args)=>notices.push(args)};
  const controller=new GroupMute(opts);
  const engine=new SocialEngine({buffer,batchMs:5,modeFor:()=> 'hybrid',muteStateFor:key=>controller.state(key),wakeWords:['小鱼'],
    decide:async(_key,prompt)=>{decisions.push(prompt);return 'RESPOND: 只回艾特';},send:async(message,text)=>outputs.push({text,scope:message.muteMentionId})});
  t.after(()=>engine.stop());
  const self=onebotId('wxid_bot');
  const adapter=Object.assign(Object.create(HookOneBot.prototype),{directory:root,ownWxid:'wxid_bot',project:{account:{nicknames:['小鱼']}},targetsSending:new Set(['group:123']),hook:{},reload(){},allowed:()=>true});
  const incoming=(content,rawid)=>normalizeOneBotEvent('wechat','wechat-onebot',adapter.incoming({event:'message.new',sessionId:'demo@chatroom',conversationId:123,talkerId:'wxid_member',type:1,content,rawid}));
  const wait=()=>new Promise(resolve=>setTimeout(resolve,60));
  assert(controller.handle(key,command('闭嘴 1档 30分钟','tier1','wxid_admin',now)));
  const scope=controller.state(key).id;
  assert.equal(controller.state(key).until,now+30*60000);
  engine.receive(incoming('小鱼，你在吗？','name-only'));
  engine.receive(incoming('只是打字 @小鱼','typed-at'));
  engine.receive({...incoming('问其他人','other-at'),self_id:String(self),segments:[{type:'at',data:{qq:'99999'}}],raw:undefined});
  await wait();assert.equal(decisions.length,0);
  engine.receive(incoming('@小鱼\u2005你在吗？','actual-at'));
  await wait();assert.deepEqual(outputs,[{text:'只回艾特',scope}]);
  await assert.rejects(adapter.send('group','123','scope allowed',undefined,null,undefined,undefined,false,scope),/SENDER_BUSY/);
  await assert.rejects(adapter.send('group','123','auto reply'),/GROUP_MUTED/);
  await assert.rejects(adapter.sendSticker('group','123','auto sticker'),/GROUP_MUTED/);
  assert(controller.handle(key,command('闭嘴','default-tier2','wxid_admin',now)));
  engine.receive(incoming('@小鱼\u2005这次不能回复','actual-at-strict'));
  await wait();assert.equal(decisions.length,1);
  await assert.rejects(adapter.send('group','123','stale scope',undefined,null,undefined,undefined,false,scope),/GROUP_MUTED/);
  now+=7*24*3600000;
  const restarted=new GroupMute(opts);
  for(const [text,id,sender] of [['开麦','alias','wxid_admin'],['/解除闭嘴','slash','wxid_admin'],['解除闭嘴','unauthorized','wxid_member'],['闭嘴 1档','downgrade','wxid_admin']]){
    assert(restarted.handle(key,command(text,id,sender,now)));assert(groupMuted(root,key,now));
  }
  await restarted.tick();assert.equal(notices.length,0);
  assert(restarted.handle(key,command('解除闭嘴','exact','wxid_admin',now)));
  await restarted.tick();await restarted.tick();assert.equal(notices.length,1);
  assert(!groupMuted(root,key,now));assert.equal(buffer.unread(key).length,0);
});
