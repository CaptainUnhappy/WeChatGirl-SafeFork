import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {directory,atomicJson} from '../plugin-api/catalog.mjs';
import {protectCredential} from '../netease/client.mjs';
import format from './music-account-format.cjs';

const fault=(code)=>Object.assign(Error(code),{code});
export function createMusicAccounts(root,{protect=protectCredential,now=Date.now}={}){
  const epochs=new Map();
  function file(platform){
    if(!Object.hasOwn(format.sites,platform))throw fault('MUSIC_ACCOUNT_PLATFORM_INVALID');
    return path.join(directory(root,'state/music-accounts'),platform+'.json');
  }
  function stored(platform){
    const filename=file(platform);
    try{
      const info=fs.lstatSync(filename);
      if(!info.isFile()||info.isSymbolicLink()||info.size>65536)return null;
      const value=JSON.parse(fs.readFileSync(filename,'utf8'));
      if(value.version===1&&typeof value.protectedSession==='string')return value;
    }catch(error){if(error.code!=='ENOENT')throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');}
    return null;
  }
  function status(platform){
    const value=stored(platform),expired=!!value?.expiresAt&&now()>=value.expiresAt;
    return {loggedIn:!!value&&!expired,expired,savedAt:value?.savedAt??null};
  }
  function cancel(platform){epochs.set(platform,(epochs.get(platform)??0)+1);}
  async function save(platform,rows,{isCurrent=()=>true}={}){
    const filename=file(platform),session=format.credentials(platform,rows,now()),epoch=epochs.get(platform);
    if(!session)throw fault('MUSIC_ACCOUNT_COOKIE_MISSING');
    let encrypted;
    try{encrypted=await protect(JSON.stringify(rows.filter(row=>format.sites[platform].cookies.includes(row.name)).map(({name,value,expirationDate})=>({name,value,expirationDate}))),'protect');}
    catch{throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');}
    if(!encrypted||encrypted.length>60000)throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');
    if(epochs.get(platform)!==epoch||!isCurrent())throw fault('MUSIC_ACCOUNT_CANCELLED');
    if(fs.existsSync(filename)&&fs.lstatSync(filename).isSymbolicLink())throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');
    atomicJson(filename,{version:1,revision:crypto.randomUUID(),protectedSession:encrypted,expiresAt:session.expiresAt,savedAt:now()});
    return status(platform);
  }
  async function session(platform){
    const value=stored(platform);
    if(!value||value.expiresAt&&now()>=value.expiresAt)return null;
    let rows;
    try{rows=JSON.parse(await protect(value.protectedSession,'unprotect'));}
    catch{throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');}
    if(stored(platform)?.revision!==value.revision)return null;
    return format.credentials(platform,rows,now());
  }
  function logout(platform){
    const filename=file(platform);
    cancel(platform);
    try{fs.unlinkSync(filename);}catch(error){if(error.code!=='ENOENT')throw fault('MUSIC_ACCOUNT_STORAGE_FAILED');}
    return status(platform);
  }
  return {status,save,session,cancel,logout};
}
