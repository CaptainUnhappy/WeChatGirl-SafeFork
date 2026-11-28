const crypto=require('node:crypto');
const {sites,credentials}=require('../packages/public-media/music-account-format.cjs');

module.exports=function createExternalMusicLoginWindows({BrowserWindow,session}){
  return Object.fromEntries(Object.entries(sites).map(([platform,site])=>{
    let active;
    function allowed(raw){
      try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&site.hosts.includes(url.hostname);}
      catch{return false;}
    }
    function close(){active?.finish('cancelled');}
    function open({save,onState}){
      close();
      const partition=session.fromPartition('music-login-'+crypto.randomUUID());
      const preferences={session:partition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false};
      const parent=new BrowserWindow({width:980,height:760,title:site.name+' · 官方登录',autoHideMenuBar:true,webPreferences:preferences});
      const windows=new Set();
      let timer,finished=false,sawAccount=false;
      const deadline=Date.now()+10*60*1000;
      partition.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      partition.setPermissionCheckHandler(()=>false);
      partition.on('will-download',event=>event.preventDefault());
      function finish(state){
        if(finished)return;
        finished=true;clearTimeout(timer);active=null;
        for(const win of windows)if(!win.isDestroyed())win.destroy();
        void partition.clearStorageData().catch(()=>{});
        onState({state});
      }
      function attach(win){
        windows.add(win);
        win.webContents.setWindowOpenHandler(({url})=>allowed(url)?{action:'allow',overrideBrowserWindowOptions:{autoHideMenuBar:true,webPreferences:preferences}}:{action:'deny'});
        win.webContents.on('did-create-window',attach);
        for(const name of ['will-navigate','will-redirect'])win.webContents.on(name,(event,url)=>{if(!allowed(typeof url==='string'?url:event.url))event.preventDefault();});
        win.on('closed',()=>{windows.delete(win);if(win===parent)finish('cancelled');});
      }
      attach(parent);
      active={finish};
      async function poll(){
        if(finished)return;
        if(Date.now()>=deadline){finish('expired');return;}
        try{
          const cookieRows=(await partition.cookies.get({})).filter(row=>site.cookies.includes(row.name)&&
            site.cookieDomains.includes(row.domain?.replace(/^\./,'').toLowerCase()));
          cookieRows.sort((a,b)=>site.cookieDomains.indexOf(a.domain.replace(/^\./,'').toLowerCase())-site.cookieDomains.indexOf(b.domain.replace(/^\./,'').toLowerCase()));
          if(finished)return;
          const ready=credentials(platform,cookieRows);
          if(ready){
            onState({state:'saving'});
            await save(cookieRows,{isCurrent:()=>!finished});
            if(!finished)finish('logged-in');
            return;
          }
          if(cookieRows.some(row=>platform==='qq'?['uin','wxuin','qqmusic_uin'].includes(row.name)&&/[1-9]/.test(row.value):row.name==='KuGoo'&&/KugooID/.test(row.value))){
            if(!sawAccount)onState({state:'waiting-playback'});
            sawAccount=true;
          }
        }catch{
          if(!finished)onState({state:'retrying'});
        }
        if(!finished)timer=setTimeout(poll,2000);
      }
      onState({state:'official-window'});
      void parent.loadURL(site.url).catch(()=>{if(!finished)onState({state:'retrying'});});
      timer=setTimeout(poll,1200);
      return {mode:'official-window'};
    }
    return [platform,{open,close}];
  }));
};
