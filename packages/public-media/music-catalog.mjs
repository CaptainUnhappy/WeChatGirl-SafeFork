import {createHash} from 'node:crypto';

export const MUSIC_PROVIDERS=Object.freeze({netease:'网易云音乐',qq:'QQ 音乐',kugou:'酷狗音乐'});
export const DEFAULT_MUSIC_ORDER=Object.freeze(Object.keys(MUSIC_PROVIDERS));
export const validMusicOrder=order=>Array.isArray(order)&&order.length===DEFAULT_MUSIC_ORDER.length&&new Set(order).size===order.length&&order.every(p=>Object.hasOwn(MUSIC_PROVIDERS,p));
export const validTrackId=(platform,id)=>typeof id==='string'&&({netease:/^[1-9]\d{0,15}$/,qq:/^[a-zA-Z0-9]{10,20}$/,kugou:/^[A-Fa-f0-9]{32}$/}[platform]?.test(id)??false);
export function trackUrl(platform,id){
  if(!validTrackId(platform,id))throw failure('MEDIA_LINK_INVALID');
  if(platform==='qq')return 'https://y.qq.com/n/ryqq/songDetail/'+id;
  if(platform==='kugou')return 'https://www.kugou.com/song/#hash='+id.toUpperCase();
  return 'https://music.163.com/song?id='+id;
}
export function externalTrackLink(platform,u){
  let id;
  if(platform==='qq'&&['y.qq.com','i.y.qq.com'].includes(u.hostname)){
    id=/^\/n\/ryqq\/songDetail\/([a-zA-Z0-9]+)\/?$/.exec(u.pathname)?.[1];
    if(u.pathname==='/n/yqq/song/'||u.pathname==='/v8/playsong.html')id=u.searchParams.get('songmid');
    id??=/^\/n\/yqq\/song\/([a-zA-Z0-9]+)\.html$/.exec(u.pathname)?.[1];
  }
  if(platform==='kugou'&&['www.kugou.com','m.kugou.com'].includes(u.hostname)&&['/song/','/song','/play/info/'].includes(u.pathname)){
    id=(u.searchParams.get('hash')??new URLSearchParams(u.hash.slice(1)).get('hash'))?.toUpperCase();
  }
  return {kind:'song',id,url:trackUrl(platform,id)};
}
export const failure=code=>Object.assign(Error(code),{code});
const clean=value=>String(value??'').replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,150);
const people=values=>Array.isArray(values)?values.map(clean).filter(Boolean).slice(0,16):[];
const seconds=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
const endpoint=(base,params)=>base+'?'+new URLSearchParams(params);
const qqSearch='https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const qqDetail='https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
const qqPlayer='https://u.y.qq.com/cgi-bin/musicu.fcg';
const kgSearch='https://songsearch.kugou.com/song_search_v2';
const kgWebPlayer='https://wwwapi.kugou.com/play/songinfo';
const kgDetail='https://m.kugou.com/app/i/getSongInfo.php';
export function externalMediaHost(platform,host){
  if(platform==='qq')return host==='aqqmusic.tc.qq.com'||/^[a-z0-9-]+\.stream\.qqmusic\.qq\.com$/.test(host);
  return platform==='kugou'&&['sharefs.kugou.com','webfs.kugou.com','fs.w.kugou.com'].includes(host);
}
async function request(url,fetcher,signal,platform,{method='GET',payload,cookie}={}){
  const response=await fetcher(url,{method,body:payload,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(4500),...(signal?[signal]:[])]),
    headers:{Referer:platform==='qq'?'https://y.qq.com/':'https://www.kugou.com/','User-Agent':'Mozilla/5.0',Accept:'application/json',...(cookie?{Cookie:cookie}:{}),...(payload?{'Content-Type':'application/json'}:{})}});
  if(!response.ok){await response.body?.cancel();throw failure('MEDIA_PLATFORM_UNAVAILABLE');}
  const chunks=[];let count=0;
  for await(const chunk of response.body){count+=chunk.length;if(count>1024*1024)throw failure('MEDIA_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function track(platform,id,title,artists,album,duration){
  if(!validTrackId(platform,id)||!clean(title))return null;
  return {platform,id,title:clean(title),artists,artist:artists.join(' / '),album:clean(album),durationSeconds:seconds(duration),url:trackUrl(platform,id),kind:'song'};
}
export function neteaseSearchTracks(songs){
  return songs.flatMap(song=>{
    if(!Number.isSafeInteger(song.id))return [];
    const item=track('netease',String(song.id),song.name,people((song.ar??song.artists??[]).map(a=>a.name)),(song.al??song.album)?.name,Number(song.dt??song.duration??0)/1000);
    return item?[item]:[];
  });
}
export async function searchExternalMusic(platform,query,limit,{fetcher=fetch,signal}={}){
  if(!['qq','kugou'].includes(platform)||typeof query!=='string'||!query.trim()||query.length>100||!Number.isInteger(limit)||limit<1||limit>20)throw failure('MEDIA_REQUEST_INVALID');
  const url=platform==='qq'?endpoint(qqSearch,{w:query,format:'json',n:limit,p:1}):endpoint(kgSearch,{keyword:query,pagesize:limit,page:1});
  const data=await request(url,fetcher,signal,platform);
  const rows=platform==='qq'&&data.code===0?data.data?.song?.list:platform==='kugou'&&data.status===1&&data.error_code===0?data.data?.lists:null;
  if(!Array.isArray(rows))throw failure('MEDIA_PLATFORM_UNAVAILABLE');
  const seen=new Set();
  return rows.slice(0,limit).flatMap(row=>{
    const item=platform==='qq'?track(platform,row.songmid,row.songname,people(row.singer?.map(s=>s.name)),row.albumname,row.interval):
      track(platform,row.FileHash?.toUpperCase(),row.SongName,people(String(row.SingerName??'').split(/\s*[、／]\s*|\s+\/\s+/)),row.AlbumName,row.Duration);
    if(!item||seen.has(item.id))return [];
    seen.add(item.id);return [item];
  });
}
const searchText=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function relevantTrack(track,query){
  const tokens=query.split(/[\s《》“”]+/u).map(searchText).filter(Boolean);
  const fields=[track.title,track.artist,track.album].map(searchText);
  return tokens.length&&(
    tokens.every(token=>fields.some(value=>value.includes(token)))||
    fields[0]&&[fields[0]+fields[1],fields[1]+fields[0]].includes(tokens.join(''))
  );
}
export async function orderedMusicSearch(query,{order,limit=10,search,signal,requireRelevant=false}){
  const attempts=[];
  for(const platform of order){
    signal?.throwIfAborted();
    try{
      const found=await search(platform,query,limit,{signal});
      const items=requireRelevant?found.filter(item=>relevantTrack(item,query)):found;
      attempts.push({platform,status:items.length?'ready':'empty'});
      if(items.length)return {platform,items,attempts,status:'ready'};
    }catch(error){if(signal?.aborted)throw error;attempts.push({platform,status:'unavailable'});}
  }
  return {items:[],attempts,status:attempts.some(a=>a.status==='empty')?'empty':'restricted'};
}
function kugouWebQuery(id,session,now){
  // This is the public web player's request checksum. Device values come from the user's actual sign-in session.
  const values={srcappid:'2919',clientver:'20000',clienttime:now,appid:1014,platid:4,
    mid:session.mid,uuid:session.mid,dfid:session.dfid,userid:session.userId,token:session.token,hash:id};
  const salt='NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const sorted=Object.keys(values).sort().map(key=>key+'='+values[key]).join('');
  return {...values,signature:createHash('md5').update(salt+sorted+salt).digest('hex')};
}
async function kugouAccountTrack(item,session,{fetcher,signal}){
  const result=await request(endpoint(kgWebPlayer,kugouWebQuery(item.id,session,Date.now())),fetcher,signal,'kugou');
  const row=result.data;
  if(result.status!==1||result.err_code!==0||String(row?.hash??row?.Hash??'').toUpperCase()!==item.id)throw failure('SONG_ACCOUNT_AUDIO_UNAVAILABLE');
  if(Number(row.is_free_part)>0||Number(row.is_preview)>0)throw failure('SONG_TRIAL_ONLY');
  const duration=Number(row.timelength)/1000,expectedBytes=Number(row.filesize);
  if(!row.play_url||!Number.isFinite(duration)||duration<=0||!Number.isSafeInteger(expectedBytes)||expectedBytes<=0||
     item.durationSeconds&&Math.abs(item.durationSeconds-duration)>2)throw failure('SONG_ACCOUNT_AUDIO_UNAVAILABLE');
  return {...item,durationSeconds:duration,sourceUrl:item.url,url:checkedAudio('kugou',row.play_url),expectedBytes};
}
export async function externalMusicDetail(platform,id,{fetcher=fetch,signal,audio=false,accounts}={}){
  if(!['qq','kugou'].includes(platform)||!validTrackId(platform,id))throw failure('MEDIA_LINK_INVALID');
  if(platform==='qq'){
    const data=await request(endpoint(qqDetail,{songmid:id,format:'json'}),fetcher,signal,platform);
    const row=data.code===0&&Array.isArray(data.data)?data.data.find(s=>s.mid===id):null;
    if(!row)throw failure('SONG_EXACT_MATCH_NOT_FOUND');
    const item=track(platform,id,row.title??row.name,people(row.singer?.map(s=>s.name)),row.album?.name,row.interval);
    if(!item)throw failure('SONG_EXACT_MATCH_NOT_FOUND');
    if(!audio)return item;
    const session=await accounts?.session(platform);
    if(!session&&row.pay?.pay_play!==0)throw failure(accounts?'SONG_PLATFORM_LOGIN_REQUIRED':'SONG_PLATFORM_AUDIO_UNAVAILABLE');
    if(!item.durationSeconds)throw failure('SONG_PLATFORM_AUDIO_UNAVAILABLE');
    const authorized=auth=>auth?'SONG_ACCOUNT_AUDIO_UNAVAILABLE':'SONG_PLATFORM_AUDIO_UNAVAILABLE';
    async function play(auth){
      const uin=auth?.userId??'0';
      const dataParam={req:{module:'vkey.GetVkeyServer',method:'CgiGetVkey',param:{guid:'0',songmid:[id],songtype:[0],uin,loginflag:auth?1:0,platform:'20'}},
        comm:{uin:auth?uin:0,format:'json',ct:auth?19:24,cv:0,...(auth?{authst:auth.key}:{})}};
      const payload=JSON.stringify(dataParam);
      const player=auth?await request(qqPlayer,fetcher,signal,platform,{method:'POST',payload,cookie:auth.cookie}):
        await request(endpoint(qqPlayer,{data:payload}),fetcher,signal,platform);
      const stream=player.req?.data;
      const key=stream?.midurlinfo?.find(s=>s.songmid===id&&s.result===0)?.purl;
      if(player.code!==0||player.req?.code!==0||typeof key!=='string'||!/^C400[a-zA-Z0-9]+\.m4a\?/.test(key))throw failure(authorized(auth));
      for(const origin of stream.sip??[]){
        try{return {...item,sourceUrl:item.url,url:checkedAudio(platform,new URL(key,origin).href),expectedBytes:Number(row.file?.size_96aac)};}catch{}
      }
      throw failure(authorized(auth));
    }
    try{return await play(session);}catch(error){
      if(!session||row.pay?.pay_play!==0||signal?.aborted)throw error;
      return play(null);
    }
  }
  const row=await request(endpoint(kgDetail,{cmd:'playInfo',hash:id}),fetcher,signal,platform);
  if(row.hash?.toUpperCase()!==id.toUpperCase())throw failure('SONG_EXACT_MATCH_NOT_FOUND');
  const artists=people(row.authors?.map(a=>a.author_name));
  const prefix=String(row.author_name??row.singerName??'')+' - ';
  const title=prefix.length>3&&row.fileName?.startsWith(prefix)?row.fileName.slice(prefix.length):row.songName;
  const item=track(platform,id.toUpperCase(),title,artists.length?artists:people([row.author_name??row.singerName]),row.album_name,row.timeLength);
  if(!item)throw failure('SONG_EXACT_MATCH_NOT_FOUND');
  if(!audio)return item;
  if(row.status!==1||row.privilege!==0||row.pay_type!==0||!item.durationSeconds||!row.url){
    const session=await accounts?.session(platform);
    if(!session)throw failure(accounts?'SONG_PLATFORM_LOGIN_REQUIRED':'SONG_PLATFORM_AUDIO_UNAVAILABLE');
    return kugouAccountTrack(item,session,{fetcher,signal});
  }
  return {...item,sourceUrl:item.url,url:checkedAudio(platform,row.url),expectedBytes:Number(row.fileSize)};
}
function checkedAudio(platform,raw){
  const url=new URL(raw);
  if(url.protocol==='http:')url.protocol='https:';
  if(url.protocol!=='https:'||url.username||url.password||url.port||!externalMediaHost(platform,url.hostname))throw failure('SONG_SOURCE_UNSAFE');
  return url.href;
}
