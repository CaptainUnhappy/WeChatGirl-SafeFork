import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import createExternalMusicLoginWindows from './music-login-windows.cjs';
import {createMusicAccounts} from '../packages/public-media/music-accounts.mjs';
import {externalMusicDetail,trackUrl} from '../packages/public-media/music-catalog.mjs';
import {createMusicConsole} from './music-console.mjs';

const mid='00140Qhl4FpVZy',hash='FA3AAC39C127530A176D5D358A97292C';
const qqRows=[{name:'uin',value:'o12345'},{name:'qm_keyst',value:'fixture_music_qq_token'},{name:'irrelevant',value:'exclude_this'}];
const kgRows=[{name:'KuGoo',value:'KugooID=45678&t=fixture_music_kg_token&a_id=1014'},{name:'kg_mid',value:'fixture-web-mid'},{name:'kg_dfid',value:'fixture-web-dfid'}];
const json=value=>new Response(JSON.stringify(value));
const rootFor=t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechatgirl-music-accounts-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
};

test('Windows session storage is encrypted, scoped per provider and survives reopening',{skip:process.platform!=='win32'},async t=>{
  const root=rootFor(t),accounts=createMusicAccounts(root);
  await accounts.save('qq',qqRows);
  await accounts.save('kugou',kgRows);
  const raw=fs.readFileSync(path.join(root,'state/music-accounts/qq.json'),'utf8');
  assert(!raw.includes(qqRows[1].value));
  assert(!JSON.stringify(accounts.status('qq')).includes('12345'));
  const reopened=createMusicAccounts(root);
  assert.equal((await reopened.session('qq')).userId,'12345');
  assert(!((await reopened.session('qq')).cookie.includes('exclude_this')));
  assert.equal((await reopened.session('kugou')).userId,'45678');
  reopened.logout('qq');
  assert.equal(await accounts.session('qq'),null);
  assert.equal(accounts.status('kugou').loggedIn,true);
});

test('a cancelled or expired login cannot commit late or be reported as active',async t=>{
  const root=rootFor(t);
  let finish;
  const accounts=createMusicAccounts(root,{now:()=>1000,protect:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=accounts.save('qq',qqRows);
  accounts.cancel('qq');
  finish('encrypted');
  await assert.rejects(pending,/MUSIC_ACCOUNT_CANCELLED/);
  assert.equal(accounts.status('qq').loggedIn,false);
  const past=[qqRows[0],{...qqRows[1],expirationDate:0.9}];
  await assert.rejects(accounts.save('qq',past),/MUSIC_ACCOUNT_COOKIE_MISSING/);
});

test('QQ vkey receives only the selected music session via a fixed, non-redirecting request',async()=>{
  const accounts={session:async platform=>{
    assert.equal(platform,'qq');
    return {userId:'12345',key:'fixture_music_qq_token',cookie:'qm_keyst=fixture_music_qq_token'};
  }};
  const track=await externalMusicDetail('qq',mid,{accounts,audio:true,fetcher:async(raw,options)=>{
    const url=new URL(raw);
    if(url.hostname==='c.y.qq.com'){
      assert.equal(options.headers.Cookie,undefined);
      return json({code:0,data:[{mid,title:'小星星',interval:115,pay:{pay_play:1},file:{size_96aac:1000}}]});
    }
    assert.equal(url.href,'https://u.y.qq.com/cgi-bin/musicu.fcg');
    assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Cookie,'qm_keyst=fixture_music_qq_token');
    const payload=JSON.parse(options.body);
    assert.equal(payload.comm.authst,'fixture_music_qq_token');
    assert.equal(payload.req.param.loginflag,1);
    return json({code:0,req:{code:0,data:{sip:['https://aqqmusic.tc.qq.com/'],midurlinfo:[{songmid:mid,result:0,purl:'C400'+mid+'.m4a?vkey=fixture'}]}}});
  }});
  assert.equal(track.expectedBytes,1000);
  assert.equal(track.sourceUrl,trackUrl('qq',mid));
});

test('Kugou uses browser-issued account and device values; preview or another song is rejected',async()=>{
  const accounts={session:async()=>({userId:'45678',token:'fixture_music_kg_token',mid:'fixture-web-mid',dfid:'fixture-web-dfid'})};
  let detail={hash,play_url:'https://sharefs.kugou.com/song.mp3',timelength:190000,filesize:1000,is_free_part:0};
  const fetcher=async(raw,options)=>{
    const url=new URL(raw);
    assert.equal(options.redirect,'error');
    if(url.hostname==='m.kugou.com')return json({hash,songName:'小星星',status:0,timeLength:0});
    assert.equal(url.origin+url.pathname,'https://wwwapi.kugou.com/play/songinfo');
    assert.equal(url.searchParams.get('token'),'fixture_music_kg_token');
    assert.equal(url.searchParams.get('dfid'),'fixture-web-dfid');
    assert.match(url.searchParams.get('signature'),/^[a-f0-9]{32}$/);
    return json({status:1,err_code:0,data:detail});
  };
  const track=await externalMusicDetail('kugou',hash,{accounts,fetcher,audio:true});
  assert.equal(track.durationSeconds,190);
  assert.equal(track.expectedBytes,1000);
  detail={...detail,is_free_part:1};
  await assert.rejects(externalMusicDetail('kugou',hash,{accounts,fetcher,audio:true}),/SONG_TRIAL_ONLY/);
  detail={...detail,is_free_part:0,hash:'0'.repeat(32)};
  await assert.rejects(externalMusicDetail('kugou',hash,{accounts,fetcher,audio:true}),/SONG_ACCOUNT_AUDIO_UNAVAILABLE/);
});

test('console calls its own provider login, returns only status and keeps the other login intact',async t=>{
  const root=rootFor(t);
  fs.mkdirSync(path.join(root,'config'));
  fs.copyFileSync(new URL('../config/wechatagent.example.json',import.meta.url),path.join(root,'config/wechatagent.json'));
  const protect=async(value,mode)=>mode==='protect'?Buffer.from(value).toString('base64'):Buffer.from(value,'base64').toString();
  const accounts=createMusicAccounts(root,{protect}),externalMusicLogin={};
  for(const [platform,rows] of [['qq',qqRows],['kugou',kgRows]])externalMusicLogin[platform]={
    close(){},
    async open({save,onState}){await save(rows,{isCurrent:()=>true});onState({state:'logged-in'});return {mode:'official-window'};}
  };
  const music=createMusicConsole(root,{accounts,externalMusicLogin});
  for(const provider of ['qq','kugou']){
    assert.deepEqual(await music.action('account-login',{provider}),{mode:'official-window'});
    const status=await music.action('account-status',{provider});
    assert.equal(status.loggedIn,true);
    assert(!JSON.stringify(status).includes('fixture'));
  }
  await music.action('account-logout',{provider:'qq'});
  assert.equal(music.snapshot().providers.qq.loggedIn,false);
  assert.equal(music.snapshot().providers.kugou.loggedIn,true);
  await assert.rejects(music.action('account-login',{provider:'unknown'}),/请选择/);
});

test('official window captures only matching music cookies and clears its isolated partition',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let latest,partitionName,cleanup=0;
  const cookies=[
    {...qqRows[0],domain:'.qq.com'},
    {name:'qm_keyst',value:'untrusted_fixture',domain:'example.com'},
    {...qqRows[1],domain:'.y.qq.com'},
    {name:'skey',value:'excluded_oauth_fixture',domain:'.qq.com'}
  ];
  const partition=Object.assign(new EventEmitter(),{
    setPermissionCheckHandler(){},setPermissionRequestHandler(){},
    cookies:{get:async()=>cookies},clearStorageData:async()=>{cleanup++;}
  });
  class Window extends EventEmitter{
    constructor(options){super();latest=this;this.options=options;this.webContents=new EventEmitter();
      this.webContents.setWindowOpenHandler=handler=>{this.openHandler=handler;};}
    loadURL(url){this.url=url;return Promise.resolve();}
    isDestroyed(){return !!this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  const windows=createExternalMusicLoginWindows({BrowserWindow:Window,session:{fromPartition(name){partitionName=name;return partition;}}});
  const states=[];
  const saved=new Promise(resolve=>{
    windows.qq.open({onState:state=>states.push(state.state),save:async rows=>resolve(rows)});
  });
  assert.match(partitionName,/^music-login-/);
  assert.equal(latest.options.webPreferences.nodeIntegration,false);
  assert.equal(latest.options.webPreferences.sandbox,true);
  assert.equal(latest.openHandler({url:'file:///C:/private'}).action,'deny');
  assert.equal(latest.openHandler({url:'https://xui.ptlogin2.qq.com/'}).action,'allow');
  t.mock.timers.tick(1200);
  assert.deepEqual((await saved).map(row=>row.value).sort(),[qqRows[0].value,qqRows[1].value].sort());
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(states,['official-window','saving','logged-in']);
  assert.equal(cleanup,1);
});
