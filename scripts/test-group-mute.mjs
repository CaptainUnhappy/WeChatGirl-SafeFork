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
