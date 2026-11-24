const broadcast=new Set(['所有人','全体成员','all']);
const validTarget=value=>/^(?:[1-9]\d{0,19}|all)$/.test(value);

export function displayedMentions(text){
  if(typeof text!=='string')return [];
  const value=text.slice(0,4000).trimStart();
  const native=[...value.matchAll(/[@＠]([^@＠\r\n\u2005]{1,80})\u2005/gu)].map(match=>match[1].trim()).filter(Boolean);
  if(native.length)return native;
  const leading=value.match(/^[@＠]([^\s，,、:：@＠]{1,64})(?=$|[\s，,、:：])/u);
  return leading?[leading[1]]:[];
}

export function incomingGroupAt(message,wakeWords=[]){
  if(message.kind!=='group'||message.outgoing||message.forwardedRecord||message.interaction)return null;
  if(['self','other'].includes(message.groupAt))return message.groupAt;
  const ids=(Array.isArray(message.segments)?message.segments:[]).filter(part=>part?.type==='at'&&part.data?.wechat_verified!==false).map(part=>String(part.data?.qq??part.data?.id??'')).filter(validTarget);
  if(ids.length)return message.self_id&&ids.includes(String(message.self_id))?'self':'other';
  if(message.platform!=='wechat')return null;
  const visible=displayedMentions(message.text);
  if(visible.length)return visible.some(name=>!broadcast.has(name)&&wakeWords.includes(name))?'self':'other';
  return null;
}

export function callsWakeName(text,wakeWords=[]){
  if(typeof text!=='string')return false;
  const line=text.trimStart();
  return wakeWords.some(word=>word&&line.startsWith(word)&&/^(?:$|[，,、:：！!？?。]|(?:在吗|在不在|你好|您好|出来|帮我|请帮我|看看|听我说))/u.test(line.slice(word.length).trimStart()));
}
