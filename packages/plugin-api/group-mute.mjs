import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson,configuration,directory,json,pluginEnabled} from './catalog.mjs';
import {activeReaderAccount} from '../../scripts/reader-account-state.mjs';
import {assistantAdministrator,verifiedAssistantSender} from '../dsh-social-bridge-plugin/assistant-policy.mjs';

const id='group-mute';
const group=/^wechat:group:[1-9]\d{0,15}$/;
const base=account=>`state/accounts/${account}/${id}`;
const fileFor=(root,account,key)=>path.join(root,base(account),key.split(':').at(-1)+'.json');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

function readState(root,account,key){
  try{
    const file=fileFor(root,account,key),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return null;
    const value=json(file);
    return value?.key===key&&/^[a-f0-9]{64}$/.test(value.id??'')&&Number.isSafeInteger(value.since)&&Number.isSafeInteger(value.until)&&
      value.until>=value.since&&['pending','submitted'].includes(value.notice)?value:null;
  }catch{return null;}
}

export function groupMuteState(root,key){
  if(!group.test(key)||!pluginEnabled(root,id,key))return null;
  const account=activeReaderAccount(root).id;
  return account?readState(root,account,key):null;
}

export const groupMuted=(root,key,now=Date.now())=>(groupMuteState(root,key)?.until??0)>now;
export const suppressedGroupJob=(root,key,createdAt)=>(groupMuteState(root,key)?.until??0)>=createdAt;

export const validMuteMentionId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function groupMuteBlocks(state,mentionId,now=Date.now()){
  return mentionId ? !(state?.mode===1&&state.until>now&&state.id===mentionId) : (state?.until??0)>now;
}
export function explicitlyMentionsSelf(message){
  const segments=message.raw?.message??message.segments;
  return message.groupAt!=='other'&&!message.forwardedRecord&&!message.interaction&&!!message.self_id&&Array.isArray(segments)&&segments.some(part=>
    part?.type==='at'&&String(part.data?.qq)===String(message.self_id)&&
    // A typed suffix is supported for commands but does not count as a native alert.
    (part.data.wechat_text===undefined||part.data.wechat_verified===true));
}

export function groupMuteCommand(message){
  if(message.kind!=='group'||message.groupAt==='other'||message.outgoing||message.voice||message.videoId||message.quoteReply||message.forwardedRecord||message.interaction)return null;
  const segments=message.raw?.message??message.segments;
  if(Array.isArray(segments)&&segments.some(part=>part.type!=='text'&&(part.type!=='at'||String(part.data?.qq)!==String(message.self_id))))return null;
  let text=(Array.isArray(segments)?segments.filter(part=>part.type==='text').map(part=>part.data?.text??'').join(''):String(message.text??'')).trim();
  if(Array.isArray(segments)){
    const mention=segments.find(part=>part.type==='at')?.data?.wechat_text;
    if(typeof mention==='string'&&mention.startsWith('@')&&mention.length>1){
      if(text.startsWith(mention+'\u2005'))text=text.slice(mention.length+1).trimStart();
      else if(text.endsWith(mention))text=text.slice(0,-mention.length).trimEnd();
    }
  }
  if(text==='解除闭嘴')return {action:'resume',strict:true};
  if(/^\/?(?:解除闭嘴|解除静音|开麦)$/.test(text))return {action:'resume'};
  const match=/^\/?(?:闭嘴|静音)(?:\s*([12])\s*档)?(?:\s*(\d{1,5})\s*(分钟|小时|分|钟头|h|m)?)?$/i.exec(text);
  if(!match)return null;
  const minutes=match[2]===undefined?undefined:Number(match[2])*(/^(?:小时|钟头|h)$/i.test(match[3]??'')?60:1);
  return {action:'mute',minutes,...(match[1]?{mode:Number(match[1])}:{})};
}

export class GroupMute {
  constructor({root,account,settingsFor,generate,send,isReady=()=>true,onMute=()=>{},now=Date.now,log=()=>{}}){
    Object.assign(this,{root,account,settingsFor,generate,send,isReady,onMute,now,log});
  }
  current(){return !!this.account&&activeReaderAccount(this.root).id===this.account;}
  state(key){return this.current()?groupMuteState(this.root,key):null;}
  write(key,state){directory(this.root,base(this.account));atomicJson(fileFor(this.root,this.account,key),state);}
  handle(key,message){
    const command=groupMuteCommand(message);
    if(!group.test(key)||!command||!this.current()||!pluginEnabled(this.root,id,key))return false;
    const sender=verifiedAssistantSender(message),settings=configuration(this.root).config.plugins[id].settings??{};
    if(!sender||!((settings.extraOperators??[]).includes(sender)||settings.useAssistantAdministrators!==false&&assistantAdministrator(this.settingsFor(),sender)))return true;
    const previous=this.state(key),now=this.now();
    const commandId=digest(key+'\0'+String(message.message_id));
    if(!message.message_id||previous?.commandId===commandId||previous&&Number(message.timestamp)*1000<Math.floor(previous.since/1000)*1000)return true;
    if(command.action==='resume'){
      if(previous?.mode===2&&!command.strict)return true;
      if(previous?.until>now){
        this.write(key,{...previous,until:now,commandId});
        this.log('[GroupMute] resumed');
      }
      return true;
    }
    if(previous?.mode===2&&previous.until>now)return true;
    const mode=command.mode??(command.minutes===undefined&&settings.defaultMode==='二档 · 完全静音'?2:1);
    if(mode===2){
      if(command.minutes!==undefined)return true;
      this.write(key,{key,id:commandId,commandId,since:now,until:Number.MAX_SAFE_INTEGER,mode,notice:'pending'});
      this.onMute(key);
      this.log('[GroupMute] muted mode=2');
      return true;
    }
    const limit=settings.maxMinutes??120,minutes=command.minutes??Math.min(settings.defaultMinutes??15,limit);
    if(!Number.isSafeInteger(minutes)||minutes<1||minutes>limit||minutes>1440)return true;
    this.write(key,{key,id:commandId,commandId,since:now,until:now+minutes*60000,mode,notice:'pending'});
    this.onMute(key);
    this.log('[GroupMute] muted minutes='+minutes);
    return true;
  }
  async tick(){
    if(this.busy||!this.current()||!this.isReady())return;
    this.busy=true;
    try{
      const folder=path.join(this.root,base(this.account));
      if(!fs.existsSync(folder))return;
      for(const name of fs.readdirSync(folder)){
        if(this.stopped||!this.isReady())break;
        if(!/^[1-9]\d{0,15}\.json$/.test(name))continue;
        const key='wechat:group:'+name.slice(0,-5),state=this.state(key);
        if(!state||state.until>this.now()||state.notice!=='pending')continue;
        const text=await this.generate(key,state.id).catch(()=>null);
        if(!text||this.stopped||!this.isReady())continue;
        const latest=this.state(key);
        if(!latest||latest.id!==state.id||latest.until>this.now()||latest.notice!=='pending')continue;
        // Once submitted, never repeat an uncertain send or a confirmed notification.
        this.write(key,{...latest,notice:'submitted'});
        try{await this.send(key,text,digest(state.id+'\0group-mute-resume'));}
        catch(error){
          const current=this.state(key);
          if(error.code==='SENDER_BUSY'&&current?.id===latest.id)this.write(key,{...current,notice:'pending'});
          else this.log('[GroupMute] resume_notice_unconfirmed');
        }
      }
    }finally{this.busy=false;}
  }
  stop(){this.stopped=true;}
}
