import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {HookOneBot} from './hook-onebot.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine,isDirectMention} from '../components/qq-bridge/src/core/social-engine.js';

const key='wechat:group:123',names=['小鱼'];
const hook=Object.assign(Object.create(HookOneBot.prototype),{ownWxid:'wxid_fish',project:{account:{nicknames:names}},reload(){},allowed:()=>true});
const msg=(id,content,extra={})=>normalizeOneBotEvent('wechat','wechat-onebot',hook.incoming({event:'message.new',sessionId:'fixture@chatroom',conversationId:123,talkerId:'wxid_member',type:1,rawid:id,content,...extra}));
const quote={version:1,reply:'小鱼，你知道吗？',reference:{messageId:'123',senderId:'wxid_else',senderName:'小张',time:'',kind:'1',text:'群成员的上一条消息',conversationId:'fixture@chatroom',senderRelation:'other'}};

async function until(check){
 const stop=Date.now()+2000;
 while(!check()&&Date.now()<stop)await delay(10);
 assert.ok(check());
}
function fixture(t,mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-address-'));
 const file=path.join(root,'buffer.json'),buffer=new MessageBuffer(file),calls=[],sent=[];
 const engine=new SocialEngine({buffer,wakeWords:names,batchMs:12,minIntervalMs:0,modeFor:()=>mode,
   decide:async(_key,prompt,meta)=>{calls.push({prompt,direct:meta.groupEngagement.direct});return meta.groupEngagement.direct?'RESPOND: 我在这里':'SILENT';},
   send:async(_msg,text)=>sent.push(text)});
 t.after(()=>{engine.stop();fs.rmSync(root,{recursive:true,force:true});});
 return {engine,buffer,file,calls,sent};
}
test('real recipient metadata overrides a same-name @ and a nickname in prose is not a summons',()=>{
 assert.equal(msg('alias','@小鱼\u2005帮忙看一下',{mentionWxids:['wxid_else']}).groupAt,'other');
 assert.equal(isDirectMention(msg('alias','@小鱼\u2005帮忙看一下',{mentionWxids:['wxid_else']}),names),false);
 assert.equal(msg('alias2','@花名\u2005在吗',{mentionWxids:['wxid_fish']}).groupAt,'self');
 assert.equal(isDirectMention(msg('mention','@小张\u2005@小鱼\u2005在吗',{mentionWxids:['wxid_else','wxid_fish']}),names),true);
 assert.equal(isDirectMention(msg('third','小鱼昨天说这家店不错'),names),false);
 assert.equal(isDirectMention(msg('quoted-nickname','提到小鱼并不是在叫她'),names),false);
 assert.equal(isDirectMention(msg('vocative','小鱼在吗？'),names),true);
});
for(const mode of ['mention','hybrid'])test(mode+' archives messages addressed to others before any model call and handles genuine @ normally',async t=>{
 const {engine,buffer,file,calls,sent}=fixture(t,mode);
 engine.receive(msg('text-other','@小张\u2005请问小鱼之前提到的是哪家店？'));
 engine.receive(msg('real-other','@小鱼\u2005请问菜单',{mentionWxids:['wxid_else']}));
 engine.receive(msg('quote-other',quote.reply,{type:49,quoteReply:quote}));
 await delay(55);
 assert.equal(calls.length,0);assert.equal(sent.length,0);
 assert(new MessageBuffer(file).recent(key,10).every(row=>row.processed&&!row.direct_mention));
 engine.receive(msg('ambient','这句话只是提到小鱼的名字'));
 if(mode==='hybrid'){
   await until(()=>calls.length===1);
   assert.equal(calls[0].direct,false);assert.match(calls[0].prompt,/“你”不一定是你/);
 }else{await delay(45);assert.equal(calls.length,0);}
 engine.receive(msg('real-self','@小鱼\u2005你在吗',{mentionWxids:['wxid_fish']}));
 await until(()=>sent.length===1);
 const last=calls.at(-1);
 assert.equal(last.direct,true);assert.match(last.prompt,/本条明确在叫你/);assert.doesNotMatch(last.prompt,/请问菜单|哪家店|群成员的上一条消息/);
 assert(buffer.recent(key,10).find(row=>row.message_id==='real-self')?.groupAt==='self');
});
