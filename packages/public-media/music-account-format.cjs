const sites=Object.freeze({
  qq:{name:'QQ 音乐',url:'https://y.qq.com/n/ryqq/index.html',hosts:['y.qq.com','i.y.qq.com','xui.ptlogin2.qq.com','ssl.xui.ptlogin2.qq.com','ssl.ptlogin2.qq.com','ptlogin2.qq.com','graph.qq.com','openmobile.qq.com','open.weixin.qq.com'],cookieDomains:['y.qq.com','u.y.qq.com','i.y.qq.com','qqmusic.qq.com','music.qq.com','qq.com'],cookies:['uin','qqmusic_uin','wxuin','login_type','qm_keyst','qqmusic_key','music_key','wxskey']},
  kugou:{name:'酷狗音乐',url:'https://www.kugou.com/',hosts:['www.kugou.com','login-user.kugou.com','openplat-user.kugou.com','reg-user.kugou.com','verifycode.service.kugou.com','xui.ptlogin2.qq.com','ssl.ptlogin2.qq.com','graph.qq.com','open.weixin.qq.com'],cookieDomains:['www.kugou.com','kugou.com','login-user.kugou.com'],cookies:['KuGoo','kg_mid','kg_dfid']}
});
const decode=value=>{try{return decodeURIComponent(value);}catch{return value;}};
const id=value=>/^[1-9]\d{0,19}$/.test(value??'');
function credentials(platform,rows,now=Date.now()){
  if(!Object.hasOwn(sites,platform)||!Array.isArray(rows))return null;
  const jar=new Map();
  for(const row of rows){
    if(!sites[platform].cookies.includes(row?.name)||typeof row.value!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(row.value)||/[;,]/.test(row.value))continue;
    const expiry=row.expirationDate===undefined?null:Number(row.expirationDate)*1000;
    if(expiry!==null&&(!Number.isFinite(expiry)||expiry<=now))continue;
    if(!jar.has(row.name))jar.set(row.name,{value:row.value,expiry});
  }
  const val=name=>jar.get(name)?.value??'';
  if(platform==='qq'){
    const uins=val('login_type')==='2'?['wxuin','uin','qqmusic_uin']:['uin','qqmusic_uin','wxuin'];
    const identity=uins.find(name=>id(val(name).replace(/^o?0*/i,'')));
    const keyName=['qm_keyst','qqmusic_key','music_key','wxskey'].find(name=>val(name));
    if(!identity||!keyName)return null;
    const key=decode(val(keyName));
    if(!/^[a-zA-Z0-9_+/.=~-]{8,4096}$/.test(key))return null;
    const expiresAt=Math.min(jar.get(identity).expiry??Infinity,jar.get(keyName).expiry??Infinity);
    return {userId:val(identity).replace(/^o?0*/i,''),key,expiresAt:Number.isFinite(expiresAt)?expiresAt:null,
      cookie:[...jar].map(([name,item])=>name+'='+item.value).join('; ')};
  }
  const raw=val('KuGoo');
  const fields=new URLSearchParams(raw.includes('&')?raw:decode(raw));
  const userId=fields.get('KugooID'),token=fields.get('t'),appid=fields.get('a_id');
  const mid=val('kg_mid'),dfid=val('kg_dfid');
  if(!id(userId)||!token||!/^[a-zA-Z0-9_+/.=~-]{8,4096}$/.test(token)||appid&&!['1010','1014'].includes(appid)||
     !/^[a-zA-Z0-9_-]{8,128}$/.test(mid)||!/^[a-zA-Z0-9_-]{8,128}$/.test(dfid))return null;
  const expiresAt=Math.min(...['KuGoo','kg_mid','kg_dfid'].map(name=>jar.get(name).expiry??Infinity));
  return {userId,token,mid,dfid,expiresAt:Number.isFinite(expiresAt)?expiresAt:null};
}
module.exports={sites,credentials};
