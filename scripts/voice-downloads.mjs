import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const VOICE_DOWNLOADS=JSON.parse(fs.readFileSync(new URL('../packaging/windows/voice-downloads.json',import.meta.url),'utf8'));
const execute=promisify(execFile);
const fault=(message,status=409)=>Object.assign(Error(message),{status});
function directory(root,relative){
  let dir=root;
  for(const component of relative.split('/')){
    dir=path.join(dir,component);
    try{fs.mkdirSync(dir);}catch(error){if(error.code!=='EEXIST')throw error;}
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('模型目录不安全，请检查目录是否为链接。');
  }
  return dir;
}
function exists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

export function createVoiceDownloads({root,python,fetchImpl=fetch,spec=VOICE_DOWNLOADS}){
  let job=null,controller=null,pending=null;
  const targetFor=(id,item)=>path.join(root,item.directory,...(id==='breeze'?[item.files[0].name]:[]));
  const snapshot=()=>({items:Object.entries(spec).map(([id,item])=>({id,name:item.name,source:item.source,license:item.license,bytes:item.files.reduce((sum,file)=>sum+file.bytes,0),exists:exists(targetFor(id,item))})),job});
  async function download(item,stage,signal){
    const file=path.join(stage,item.name);
    for(const url of item.urls){
      try{
        const response=await fetchImpl(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});
        if(response.status!==200||!response.body){await response.body?.cancel();throw Error('SOURCE');}
        const size=response.headers.get('content-length');
        if(size!==null&&Number(size)!==item.bytes){await response.body.cancel();throw Error('SIZE');}
        const sha=crypto.createHash('sha256');let bytes=0;
        await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,callback){
          bytes+=chunk.length;
          if(bytes>item.bytes){callback(Error('SIZE'));return;}
          sha.update(chunk);job.fileBytes=bytes;callback(null,chunk);
        }}),fs.createWriteStream(file,{flags:'wx'}),{signal});
        if(bytes!==item.bytes||sha.digest('hex')!==item.sha256)throw Error('HASH');
        return;
      }catch(error){
        fs.rmSync(file,{force:true});
        if(signal.aborted)throw error;
        if(url===item.urls.at(-1))throw fault(error.message==='HASH'||error.message==='SIZE'?'文件校验失败，已丢弃临时文件。':'下载源暂时不可用，请检查网络后重试。');
      }
    }
  }
  async function run(id,item,signal){
    const isBreeze=id==='breeze',target=targetFor(id,item);
    if(!isBreeze){
      try{await execute(python(),['-I','-B','-c','import sys; assert sys.version_info[:2] == (3,13)'],{signal,windowsHide:true,timeout:10000});}
      catch{throw fault('本机识别需要发行版内置的 Python 3.13，请检查运行环境设置。');}
    }
    const parent=directory(root,isBreeze?item.directory:item.directory.split('/').slice(0,-1).join('/'));
    const available=fs.statfsSync(parent,{bigint:true});
    if(available.bavail*available.bsize<BigInt(job.total+128*1024*1024))throw fault('磁盘空间不足，请清理后重试。');
    const stage=fs.mkdtempSync(path.join(parent,'.voice-download-'));
    try{
      for(const file of item.files){
        Object.assign(job,{file:file.name,fileBytes:0});
        await download(file,stage,signal);
        job.done+=file.bytes;job.fileBytes=0;
      }
      if(!isBreeze){
        job.phase='installing';
        const wheels=item.files.filter(file=>file.name.endsWith('.whl')).map(file=>path.join(stage,file.name));
        // Only the two pinned Windows wheels are unpacked; no pip network access or setup scripts.
        const program='import pathlib,sys,zipfile; assert sys.version_info[:2] == (3,13); dest=pathlib.Path(sys.argv[1]); [zipfile.ZipFile(p).extractall(dest) for p in sys.argv[2:]]';
        await execute(python(),['-I','-B','-c',program,path.join(stage,'site'),...wheels],{signal,windowsHide:true,timeout:120000});
        if(!fs.existsSync(path.join(stage,'site/sherpa_onnx/__init__.py')))throw fault('语音识别运行库未能安装，请检查内置 Python。');
        for(const file of wheels)fs.unlinkSync(file);
      }
      signal.throwIfAborted();
      if(exists(target))throw fault('目标已经存在，保留原文件。');
      if(isBreeze)fs.linkSync(path.join(stage,item.files[0].name),target);
      else fs.renameSync(stage,target);
    }finally{fs.rmSync(stage,{recursive:true,force:true});}
  }
  return {snapshot,
    start(body){
      if(!body||!Object.hasOwn(spec,body.id)||Object.keys(body).some(key=>!['id','acceptLicense'].includes(key))||body.acceptLicense!==true)throw fault('请先确认模型使用条款。',400);
      if(pending)throw fault('已有下载正在进行。');
      const item=spec[body.id];
      if(exists(targetFor(body.id,item)))throw fault('目标已存在，程序不会覆盖已有模型。');
      controller=new AbortController();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90*60000)]);
      job={id:body.id,phase:'downloading',done:0,fileBytes:0,total:item.files.reduce((sum,file)=>sum+file.bytes,0)};
      pending=run(body.id,item,signal).then(()=>{job.phase='complete';job.message='已下载并校验。';}).catch(error=>{
        job.phase=controller.signal.aborted?'cancelled':'failed';
        job.message=controller.signal.aborted?'已取消下载。':error.status?error.message:'下载或安装未完成，请检查网络、磁盘和内置 Python 后重试。';
      }).finally(()=>{pending=null;controller=null;});
      return snapshot();
    },
    cancel(){controller?.abort();return snapshot();},
    wait:()=>pending??Promise.resolve()
  };
}
