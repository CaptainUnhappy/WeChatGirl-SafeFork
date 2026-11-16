import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {HookOneBot} from './hook-onebot.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {createWebReaderTurn} from '../packages/dsh-social-bridge-plugin/web-reader.mjs';
import {extractWebContent} from '../packages/dsh-social-bridge-plugin/web-reader-content.mjs';

const python=process.env.WECHAT_ARTICLE_TEST_PYTHON;
const url='https://mp.weixin.qq.com/s?__biz=fixture&mid=1&idx=1&sn=test';

test('a public account article card becomes the original readable link in a group turn',{skip:!python,timeout:7000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-article-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const program=String.raw`
import json, sys
sys.path.insert(0, 'scripts')
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('reader_fixture', 'scripts/reader-api.py')
reader = module_from_spec(spec)
spec.loader.exec_module(reader)
card = '<msg><appmsg><type>5</type><title>测试文章 https://ignored.example.com</title><url>http://mp.weixin.qq.com/s?__biz=fixture&amp;mid=1&amp;idx=1&amp;sn=test#rd</url></appmsg></msg>'
row = dict(localType=reader.ARTICLE_CARD_TYPES[1], serverId='82', localId=1, createTime=0, senderUsername='wxid_fixture', fullText=card)
def push(msg):
    return reader.push_payload('test@chatroom',msg,{},'wxid_self','123')
for invalid in (card.replace('mp.weixin.qq.com', 'mp.weixin.qq.com.evil.test'), card.replace('qq.com/s?', 'qq.com/join?'), card.replace('<type>5', '<type>33')):
    assert not push(dict(row,fullText=invalid))
assert not push(dict(row,isSend=True))
assert push(dict(row,localType=49))['content'] == push(row)['content']
print(json.dumps(push(row)))`;
  const payload=JSON.parse(execFileSync(python,['-B','-c',program],{encoding:'utf8',windowsHide:true,timeout:5000}));
  assert.equal(payload.content,url);
  const adapter=Object.assign(Object.create(HookOneBot.prototype),{reload(){},allowed:()=>true,ownWxid:'wxid_self',project:{account:{nicknames:[]}}});
  const article=normalizeOneBotEvent('wechat','fixture',adapter.incoming(payload));
  const requested=Promise.withResolvers();
  const reply=new SocialEngine({buffer:new MessageBuffer(path.join(root,'messages.json')),modeFor:()=> 'mention',batchMs:5,
    decide:async(_key,prompt,metadata)=>{requested.resolve({prompt,metadata});return 'SILENT';},send:async()=>{}});
  t.after(()=>reply.stop());
  reply.receive(article);
  reply.receive(normalizeOneBotEvent('wechat','fixture',{post_type:'message',message_type:'group',group_id:123,user_id:789,self_id:article.self_id,message_id:'wake',
    message:[{type:'at',data:{qq:article.self_id}},{type:'text',data:{text:'请总结刚发的文章'}}]}));
  const {prompt,metadata}=await requested.promise;
  assert.deepEqual(metadata.webReaderUrls,[url]);
  assert.deepEqual([...createWebReaderTurn(prompt,metadata.webReaderUrls).urls],[url]);
  assert(!prompt.includes('ignored.example.com'));
});

test('WeChat article text is read from its official content block, not from the verification page',()=>{
  const text='这是用于验证公众号文章提取的网页正文。'.repeat(10);
  const html=`<html><head><meta property="og:title" content="文章测试"></head><body><div>页脚干扰</div><div class="rich_media_content" id="js_content" style="visibility:hidden;opacity:0"><script>忽略脚本</script>${text}</div></body></html>`;
  const article=extractWebContent(html,'text/html',{sourceUrl:url});
  assert.deepEqual(article,{title:'文章测试',text,truncated:false});
  assert.equal(extractWebContent(html,'text/html',{sourceUrl:'https://example.com/s'}).text,'页脚干扰');
  assert.throws(()=>extractWebContent('<p>请完成验证</p>','text/html',{sourceUrl:url}),/访问验证/);
  assert.throws(()=>extractWebContent('<p>只有页脚</p>','text/html',{sourceUrl:url}),/未取得公众号文章正文/);
});
