import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMusicConsole} from './music-console.mjs';
import {MusicPreferences} from '../packages/voice-studio/music-preferences.mjs';
import {findOrderedSong,musicFetch} from '../packages/voice-studio/music.mjs';
import {createPublicMedia,songLink} from '../packages/public-media/index.mjs';
import {externalMusicDetail,trackUrl} from '../packages/public-media/music-catalog.mjs';
import {voiceRequest} from '../packages/voice-studio/jobs.mjs';

const qq='00140Qhl4FpVZy',kg='FA3AAC39C127530A176D5D358A97292C';
const respond=value=>new Response(JSON.stringify(value));

test('saved search order survives reopening and skips timeouts and unrelated matches; explicit platform stays fixed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'music-order-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const prefs=new MusicPreferences(root),previous=prefs.snapshot();
  assert.deepEqual(previous.order,['netease','qq','kugou']);
  assert.throws(()=>prefs.save({revision:previous.revision,order:['qq','qq','netease']}),/顺序/);
  prefs.save({revision:previous.revision,order:['qq','kugou','netease']});
  assert.throws(()=>prefs.save({revision:previous.revision,mode:'full'}),/已变化/);
  const reopened=new MusicPreferences(root);
  reopened.save({revision:reopened.snapshot().revision,mode:'full'});
  assert.deepEqual(reopened.snapshot().order,['qq','kugou','netease']);
  const client={search:async()=>[{id:1,name:'小星星',ar:[{name:'汪苏泷'}]}]};
  const console=createMusicConsole(root,{client,fetcher:async raw=>{
    const host=new URL(raw).hostname;
    if(host==='c.y.qq.com')throw Error('timeout');
    assert.equal(host,'songsearch.kugou.com');
    return respond({status:1,error_code:0,data:{lists:[{FileHash:kg,SongName:'另一首',SingerName:'汪苏泷'}]}});
  }});
  const found=await console.action('search',{query:'汪苏泷 小星星'});
  assert.deepEqual(found.attempts,[{platform:'qq',status:'unavailable'},{platform:'kugou',status:'empty'},{platform:'netease',status:'ready'}]);
  assert.equal(found.items[0].platform,'netease');
  assert.equal((await console.action('search',{query:'汪苏泷',provider:'kugou'})).platform,'kugou');
});

test('platform song identity is retained through link reading and point-song requests',async()=>{
  const link=trackUrl('kugou',kg);
  assert.deepEqual(songLink(link),{platform:'kugou',kind:'song',id:kg,url:link});
  assert.equal(voiceRequest({kind:'song',sourceUrl:trackUrl('qq',qq)}).sourceUrl,trackUrl('qq',qq));
  assert.throws(()=>songLink('https://www.kugou.com.evil.test/song/#hash='+kg),/INVALID/);
  const read=createPublicMedia({fetchImpl:async()=>respond({hash:kg,fileName:'歌手 - 歌名 (Live)',songName:'歌名',author_name:'歌手',timeLength:123})});
  const result=await read('read',{platform:'music',url:link});
  assert.equal(result.title,'歌名 (Live)');
  assert.equal(result.singingRequest.args.sourceUrl,link);
});

test('ordered singing skips a restricted provider and keeps the requested exact title and artist',async()=>{
  const attempted=[];
  const result=await findOrderedSong(['qq','kugou','netease'],'晴天','周杰伦',{
    search:async platform=>[{title:'晴天 (Live)',artists:['周杰伦'],id:'wrong-version'},{title:'晴天',artists:['别人'],id:'wrong-artist'},{title:'晴天',artists:['周杰伦'],id:platform}],
    detail:async(platform,id)=>{attempted.push([platform,id]);if(platform==='qq')throw Object.assign(Error(),{code:'SONG_PLATFORM_AUDIO_UNAVAILABLE'});return {platform,title:'晴天',artists:['周杰伦']};},
    find:async()=>assert.fail('the last platform should be skipped')
  });
  assert.equal(result.platform,'kugou');
  assert.deepEqual(attempted,[['qq','qq'],['kugou','kugou']]);
});

test('restricted tracks and unsafe redirects are rejected before use as audio',async()=>{
  const qqData=respond({code:0,data:[{mid:qq,title:'小星星',interval:115,pay:{pay_play:1}}]});
  await assert.rejects(externalMusicDetail('qq',qq,{audio:true,fetcher:async()=>qqData}),/SONG_PLATFORM_AUDIO_UNAVAILABLE/);
  const kgData=respond({hash:kg,songName:'小星星',timeLength:30,status:1,privilege:10,pay_type:1,url:'https://sharefs.kugou.com/trial.mp3'});
  await assert.rejects(externalMusicDetail('kugou',kg,{audio:true,fetcher:async()=>kgData}),/SONG_PLATFORM_AUDIO_UNAVAILABLE/);
  await assert.rejects(musicFetch('https://sharefs.kugou.com/audio.mp3',{
    media:true,platform:'kugou',fetcher:async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/'}})
  }),/SONG_SOURCE_UNSAFE/);
});
