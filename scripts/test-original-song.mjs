import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {composeOriginal,mixOriginalBacking} from '../packages/voice-studio/original.mjs';
import {voiceRequest} from '../packages/voice-studio/jobs.mjs';
import {synthesizeSinging} from '../packages/voice-studio/singing.mjs';
import {setup} from '../optional-extensions/voice-studio/index.mjs';

const verses='小雨落在屋檐\n小鱼摇着尾巴\n等到云开天晴\n一起看见彩虹';
const song={kind:'original',title:'雨后的鲸鱼',lyrics:verses,mood:'gentle'};
test('an original score pairs each sung syllable with one note and mixes a separate backing track',()=>{
  const result=composeOriginal(song);
  assert.equal(result.lyrics.split(' ').length,result.bars.flatMap(bar=>bar.tones).length);
  assert(result.bars.every(bar=>bar.beats.reduce((sum,value)=>sum+value,0)===4));
  assert.match(result.score,/Q:1\/4=84/);assert.notEqual(composeOriginal({...song,mood:'lively'}).score,result.score);
  assert.throws(()=>voiceRequest({...song,lyrics:'too short'}),/ORIGINAL_SONG_LYRICS_INVALID/);
  assert.throws(()=>voiceRequest({...song,title:'A\nM:1/4'}),/ORIGINAL_SONG_LYRICS_INVALID/);
  assert.throws(()=>voiceRequest({...song,score:'arbitrary ABC'}),/VOICE_REQUEST_INVALID/);
  const empty=Buffer.alloc(48000);
  assert(mixOriginalBacking(empty,result).some(Boolean));
  assert.deepEqual(mixOriginalBacking(empty,result,0),empty);
});
test('the composer stages one original job and renders it through the local score service, not TTS',async t=>{
  const tools=new Map();setup({registerTool:tool=>tools.set(tool.id,tool)});
  const {content}=await tools.get('compose').execute({storage:{get:async()=>null},config:()=>({}),voice:{enqueue:async req=>({staged:true,request:voiceRequest(req)})}},{title:song.title,lyrics:song.lyrics,mood:'gentle'});
  const request=JSON.parse(content).request;
  assert.equal(request.kind,'original');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-original-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const token=path.join(root,'state/voice/feiyu-service/server/.runtime/voice-service/api_key.txt');
  fs.mkdirSync(path.dirname(token),{recursive:true});fs.writeFileSync(token,'isolated-test-token');
  const stage=[],id='a'.repeat(32),calls=[];
  const fetcher=async (url,options)=>{
    assert.equal(new URL(url).host,'127.0.0.1:19882');
    const route=new URL(url).pathname;calls.push(route);
    if(route==='/v1/capabilities')return Response.json({singing:{available:true}});
    if(route==='/v1/assets'){assert.match(await options.body.get('file').text(),/^X:1\n/);return Response.json({id});}
    if(route==='/v1/singing'){const body=JSON.parse(options.body);assert.equal(body.lyrics,composeOriginal(song).lyrics);assert.equal(body.score_id,id);assert.equal(body.segment_seconds,5);return Response.json({id});}
    if(route.endsWith('/audio'))return new Response(Buffer.from('fake local vocal'));
    return Response.json({status:'success'});
  };
  const pcm=await synthesizeSinging(root,request,{fetcher,resample:async()=>Buffer.alloc(48000),onProgress:s=>stage.push(s)});
  assert(pcm.some(Boolean));assert(stage.includes('mix'));assert(calls.includes('/v1/singing'));assert(!calls.includes('/v1/voice-conversion'));
  await assert.rejects(synthesizeSinging(root,request,{fetcher:async()=>Response.json({singing:{available:false}})}),/SINGING_SCORE_ENGINE_NOT_READY/);
});
