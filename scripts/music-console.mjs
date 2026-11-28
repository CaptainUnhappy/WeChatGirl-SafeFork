import {createMusicAccounts} from '../packages/public-media/music-accounts.mjs';
import {MusicLibrary} from '../packages/voice-studio/library.mjs';
import {createNeteaseClient} from '../packages/netease/client.mjs';
import {readSendingMode} from '../packages/wechat-send-policy.mjs';
import {VoiceJobs} from '../packages/voice-studio/jobs.mjs';
import {trackForLink} from '../packages/voice-studio/music.mjs';
import {MusicPreferences} from '../packages/voice-studio/music-preferences.mjs';
import {songLink} from '../packages/public-media/index.mjs';
import {MUSIC_PROVIDERS,neteaseSearchTracks,orderedMusicSearch,searchExternalMusic,trackUrl} from '../packages/public-media/music-catalog.mjs';
const fail=message=>Object.assign(Error(message),{status:400});
export function createMusicConsole(root,{client=createNeteaseClient(root),officialLogin,externalMusicLogin,accounts=createMusicAccounts(root),fetcher=fetch}={}){
  let loginTimer,officialState={state:'idle'};
  const externalStates=new Map(),externalProviders=['qq','kugou'];
  function providerStatus(platform){
    return {...accounts.status(platform),login:externalStates.get(platform)??{state:'idle'},officialLoginAvailable:!!externalMusicLogin?.[platform]};
  }
  async function accountAction(action,platform){
    if(!externalProviders.includes(platform))throw fail('请选择 QQ 音乐或酷狗音乐。');
    const window=externalMusicLogin?.[platform];
    if(action==='account-login'){
      if(!window)throw fail('请在 WeChatGirl 桌面程序中打开官方登录窗口。');
      accounts.cancel(platform);
      return window.open({save:(rows,options)=>accounts.save(platform,rows,options),onState:value=>externalStates.set(platform,value)});
    }
    if(action==='account-status'){
      const status=providerStatus(platform);
      if(status.loggedIn&&!await accounts.session(platform))return {...providerStatus(platform),loggedIn:false,expired:true};
      return status;
    }
    window?.close();
    if(action==='account-logout')accounts.logout(platform);
    else accounts.cancel(platform);
    externalStates.delete(platform);
    return providerStatus(platform);
  }
  function watchLogin(){clearTimeout(loginTimer);loginTimer=setTimeout(async()=>{try{await client.checkLogin();}catch{}if(['waiting','confirm','retrying','saving'].includes(client.status().login?.state))watchLogin();},3000);loginTimer.unref?.();}
  return {
    close:()=>{clearTimeout(loginTimer);for(const platform of externalProviders)externalMusicLogin?.[platform]?.close();},
    snapshot:()=>({sendingMode:readSendingMode(root),account:{...client.status(),...(officialState.state!=='idle'&&!client.status().loggedIn?{login:officialState}:{})},officialLoginAvailable:!!officialLogin,providers:Object.fromEntries(externalProviders.map(platform=>[platform,providerStatus(platform)])),songs:new MusicLibrary(root).list()}),
    async action(action,body={}){
      try{
      if(action==='official-login'){
        if(!officialLogin)throw fail('请在桌面程序中使用网易云官方窗口登录。');
        clearTimeout(loginTimer);client.cancelLogin();
        return await officialLogin.open({save:value=>client.saveOfficialCookies(value),onState:state=>{officialState=state;if(state.state==='cancelled')client.cancelLogin();}});
      }
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['query','id','sourceUrl','provider'].includes(k)))throw fail('音乐请求无效。');
      if(['account-login','account-status','account-cancel','account-logout'].includes(action))return await accountAction(action,body.provider);
      if(action==='login'){const {default:qrcode}=await import('../vendor/netease-qr/qrcode.cjs'),value=await client.startLogin(),qr=qrcode(0,'M');qr.addData(value.url);qr.make();watchLogin();return {expiresAt:value.expiresAt,qrImage:'data:image/svg+xml;base64,'+Buffer.from(qr.createSvgTag(5,12)).toString('base64')};}
      if(action==='check')return client.checkLogin();
      if(action==='verify')return client.verify();
      if(action==='cancel'){clearTimeout(loginTimer);officialLogin?.close();officialState={state:'idle'};return client.cancelLogin();}
      if(action==='logout'){clearTimeout(loginTimer);officialLogin?.close();officialState={state:'idle'};return client.logout();}
      if(action==='check-song'){
        let link;try{link=songLink(body.sourceUrl??trackUrl('netease',body.id));}catch{throw fail('请选择搜索结果中的歌曲。');}
        try{const track=await trackForLink(link,{neteaseClient:client,accounts,fetcher});return {id:track.id,playable:true,message:'平台返回了完整音源地址，可以点唱；制作时还会校验音频。'};}
        catch(error){const messages={SONG_PLATFORM_LOGIN_REQUIRED:'可先在音乐页登录'+MUSIC_PROVIDERS[link.platform]+'，再检查该版本的完整音源。',SONG_PLATFORM_AUDIO_UNAVAILABLE:MUSIC_PROVIDERS[link.platform]+'未提供可用的公开完整音源。可试试搜索其他来源。',SONG_EXACT_MATCH_NOT_FOUND:'此平台未返回该歌曲版本。',SONG_SOURCE_UNSAFE:'平台未返回可用的音源地址。',SONG_LOGIN_REQUIRED:'已找到这首歌，需先登录网易云，再检查账号是否可读取。',SONG_TRIAL_ONLY:'当前平台仅返回试听片段，暂不能制作翻唱。',SONG_ACCOUNT_AUDIO_UNAVAILABLE:'当前账号未取得完整音源，可能受会员、版权或地区限制。',SONG_PUBLIC_AUDIO_UNAVAILABLE:'网易云未返回可用完整音源。'};if(messages[error.code])return {id:link.id,playable:false,reason:error.code,message:messages[error.code]};throw error;}
      }
      if(action==='search'){
        const query=typeof body.query==='string'?body.query.trim():'';
        if(!query||query.length>100||body.provider!==undefined&&body.provider!=='auto'&&!Object.hasOwn(MUSIC_PROVIDERS,body.provider))throw fail('请输入100字以内的歌名或歌手，并选择有效平台。');
        const order=body.provider&&body.provider!=='auto'?[body.provider]:new MusicPreferences(root).snapshot().order;
        return orderedMusicSearch(query,{order,limit:15,requireRelevant:order.length>1,search:async(platform,q,limit)=>{
          const signal=AbortSignal.timeout(4500);
          return platform==='netease'?neteaseSearchTracks(await client.search(q,limit,{signal})):searchExternalMusic(platform,q,limit,{fetcher,signal});
        }});
      }
      throw fail('音乐操作不存在。');
      }catch(error){if(/^(NETEASE|SONG)_[A-Z0-9_]+$/.test(error.code??'')){error.status=400;throw error;}if(error.code==='MUSIC_ACCOUNT_STORAGE_FAILED')throw fail('本机无法读取或保存加密凭据，请重新登录。');if(error.status)throw error;throw fail('音乐操作失败，请稍后重试。');}
    }
  };
}
