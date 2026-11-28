import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createVoiceDownloads} from './voice-downloads.mjs';

test('model download retries the next mirror, checks bytes, and never overwrites existing weights',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-download-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('GGUF synthetic fixture');
  const file={name:'test.gguf',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),urls:['https://first.invalid','https://second.invalid']};
  const seen=[];
  const manager=createVoiceDownloads({root,spec:{breeze:{directory:'state/models',files:[file]}},fetchImpl:async url=>{
    seen.push(url);return new Response(seen.length===1?Buffer.alloc(bytes.length):bytes);
  }});
  assert.throws(()=>manager.start({id:'breeze'}),/使用条款/);
  manager.start({id:'breeze',acceptLicense:true});
  await manager.wait();
  assert.deepEqual(seen,file.urls);
  assert.equal(manager.snapshot().job.phase,'complete');
  const target=path.join(root,'state/models/test.gguf');
  assert.deepEqual(fs.readFileSync(target),bytes);
  assert.throws(()=>manager.start({id:'breeze',acceptLicense:true}),/不会覆盖/);
});


test('interrupted Breeze transfer resumes on the next click and never exposes a partial model',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-resume-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('GGUF interrupted transfer'),piece=bytes.subarray(0,8);
 const file={name:'model.gguf',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),urls:['https://example.invalid']};
 const spec={breeze:{directory:'state/models',files:[file]}},seen=[];
 const fetchImpl=async(_url,{headers})=>{
   seen.push(headers.Range);
   if(seen.length===1)return new Response(piece);
   return new Response(bytes.subarray(piece.length),{status:206,headers:{'content-range':'bytes 8-'+(bytes.length-1)+'/'+bytes.length}});
 };
 let manager=createVoiceDownloads({root,spec,fetchImpl});
 manager.start({id:'breeze',acceptLicense:true});await manager.wait();
 assert.equal(manager.snapshot().job.phase,'failed');
 assert.equal(manager.snapshot().job.fileBytes,piece.length);
 assert.equal(manager.snapshot().items[0].exists,false);
 manager=createVoiceDownloads({root,spec,fetchImpl});
 manager.start({id:'breeze',acceptLicense:true});await manager.wait();
 assert.deepEqual(seen,[undefined,'bytes=8-']);
 assert.equal(manager.snapshot().job.phase,'complete');
 assert.deepEqual(fs.readFileSync(path.join(root,'state/models/model.gguf')),bytes);
});
