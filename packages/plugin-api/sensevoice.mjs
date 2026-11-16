import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const failure=code=>Object.assign(Error(code),{code});
const folderFor=root=>path.join(root,'state/asr/sensevoice');
const languages=new Set(['auto','zh','en','yue','ja','ko']);
let active=0;
export function senseVoiceReady(root){
  const folder=folderFor(root);
  try{return ['model.int8.onnx','tokens.txt','site/sherpa_onnx/__init__.py'].every(name=>fs.statSync(path.join(folder,name)).isFile());}catch{return false;}
}

export async function transcribeSenseVoice(root,audio,{language='auto',signal,timeoutMs=25000}={}){
  if(audio.mime!=='audio/wav'||audio.sampleRate!==16000||typeof audio.b64!=='string'||audio.b64.length>2800000)throw failure('VOICE_API_AUDIO_FORMAT_UNSUPPORTED');
  const bytes=Buffer.from(audio.b64,'base64');
  if(bytes.length>2*1024*1024||bytes.toString('base64')!==audio.b64)throw failure('VOICE_API_AUDIO_FORMAT_UNSUPPORTED');
  return runSenseVoice(root,{language,signal,timeoutMs:Math.min(25000,timeoutMs),bytes});
}

export async function transcribeSenseVoiceFile(root,audio,{language='auto',signal,timeoutMs=120000}={}){
  return runSenseVoice(root,{language,signal,timeoutMs:Math.min(120000,timeoutMs),file:audio.path});
}

async function runSenseVoice(root,{language,signal,timeoutMs,bytes,file}){
  language=language||'auto';
  if(!languages.has(language))throw failure('VOICE_SENSEVOICE_LANGUAGE_INVALID');
  if(!senseVoiceReady(root))throw failure('VOICE_SENSEVOICE_NOT_READY');
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  const python=config.runtime?.python;
  if(!python||active>=(file?1:2))throw failure(python?'VOICE_SENSEVOICE_BUSY':'VOICE_SENSEVOICE_NOT_READY');
  const deadline=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  deadline.throwIfAborted();
  active++;
  try{return await new Promise((resolve,reject)=>{
    const maxText=file?8000:4000,maxOutput=maxText*8;
    const child=spawn(python,['-I','-B',path.join(root,'scripts/sensevoice-worker.py'),folderFor(root),language,...(file?[file]:[])],
      {windowsHide:true,signal:deadline,stdio:['pipe','pipe','ignore']});
    let out='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{out+=chunk;if(out.length>maxOutput)child.kill();});
    child.stdin.on('error',()=>{});
    child.once('error',()=>reject(deadline.aborted?failure('VOICE_API_TIMEOUT'):failure('VOICE_SENSEVOICE_NOT_READY')));
    child.once('close',code=>{
      if(deadline.aborted)return reject(failure('VOICE_API_TIMEOUT'));
      if(code!==0||out.length>maxOutput)return reject(failure('VOICE_SENSEVOICE_FAILED'));
      let text;try{text=JSON.parse(out).text;}catch{}
      if(typeof text!=='string'||!text.trim()||text.length>maxText)return reject(failure('VOICE_API_EMPTY_TRANSCRIPT'));
      resolve(text.trim());
    });
    child.stdin.end(bytes);
  });}finally{active--;}
}
