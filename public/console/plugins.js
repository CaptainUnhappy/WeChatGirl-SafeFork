import {downloadLinks} from './download-links.mjs';
import {pluginCategory} from './interface-model.mjs';
import {speechModelField,speechProtocolField,speechDiagnosticsMarkup,bindSpeechSettings} from './speech-settings.mjs';
import {visionModelGroups} from './dsh-models.js';
import {PERMISSION_LABELS,FEATURE_LABELS,BUILTIN_PLUGIN_PACKAGES} from './plugin-contract.mjs';
const permissions=PERMISSION_LABELS;
export function pluginCard(item,esc,icon){
  return `<article class="extension-tile plugin-tile" data-plugin-card="${esc(item.id)}"><div class="extension-tile-top"><div><h2><button class="extension-title" data-plugin-settings="${esc(item.id)}">${esc(item.name)}</button></h2></div><button class="button extension-card-action" data-plugin-settings="${esc(item.id)}">配置</button></div><p class="extension-byline">${icon('plug')}<span>${esc(item.author||'本机插件')} · v${esc(item.version??'?')}</span></p><p class="extension-card-state"><span class="status-tag ${esc(item.statusTone)}">${esc(item.statusLabel)}</span><span>${item.chats===null?'所有允许的聊天':(item.chats??[]).length+' 个聊天'}</span></p><p class="extension-card-description">${esc(item.description)}</p>${item.serviceStatus?'<p class="speech-card-status"><span class="status-tag '+(['ok','error','warning','pending'].includes(item.serviceStatus.state)?item.serviceStatus.state:'pending')+'">'+esc(item.serviceStatus.label)+'</span><small>'+esc(item.serviceStatus.message)+'</small></p>':''}<div class="extension-card-tags"><span>${esc(item.uiCategoryName??"WeChatGirl 插件")}</span><span>API v2</span></div><footer class="extension-card-footer"><small>${esc(item.reason)}</small>${item.id==='persona-studio'?'<button class="button small" data-persona-studio>打开工作室</button>':''}${BUILTIN_PLUGIN_PACKAGES.some(p=>p.id===item.id)?'<a class="text-link" href="https://github.com/my12yyds/WeChatGirl/blob/main/docs/plugins/'+esc(item.id)+'.md" target="_blank" rel="noopener noreferrer">详细说明</a>':''}<button class="text-link" data-plugin-reclassify="${esc(item.id)}">调整分类</button><button class="text-link" data-plugin-uninstall="${esc(item.id)}">卸载</button></footer></article>`;
}
export function createPluginUI({api,modal,closeModal,confirmAction,escapeHtml:esc,state,renderPage,toast,icon}){
  let sequence=0,ticket=null;
  const names=key=>state.names.get(key)??key;
  function installMarkup(catalog){if(catalog.pluginError)return `<p class="inline-error" role="alert">${esc(catalog.pluginError)} 内置能力继续可用。</p>`;return catalog.canInstallZip?`<section class="plugin-install-entry" id="plugin-install-entry" aria-label="安装 WeChatGirl 插件"><div><strong>${icon('plug')} 把新功能放进来</strong><p>拖入 ZIP 插件，或选择文件安装。安装后可单独选择聊天与权限。</p><details class="builtin-plugin-packages"><summary>单个插件包 · ${BUILTIN_PLUGIN_PACKAGES.length} 个</summary><div>${BUILTIN_PLUGIN_PACKAGES.map(item=>{const entry=catalog.packageDownloads?.entries.find(row=>row.id===item.id);return `<div class="button-row plugin-download-row"><strong>${esc(item.name)} v${esc(item.version)}</strong>${downloadLinks(entry?.url)}</div>`;}).join('')}</div><small>在夸克网盘中选择对应 ZIP，下载后从上方导入。</small></details></div><div class="plugin-install-actions"><button class="button" data-plugin-bundle-download>从 GitHub 一键下载并导入</button><label class="button" for="plugin-bundle-file">导入插件总包</label><input id="plugin-bundle-file" type="file" accept=".zip" hidden><div class="button-row" aria-label="插件总包下载来源">${downloadLinks(catalog.packageDownloads?.all.url)}</div><button class="button primary" data-plugin-install>安装 ZIP 插件</button><a class="text-link" href="/plugin-api.md" download="WeChatGirl-plugin-api-v2.md" aria-label="下载插件开发规范 Markdown">开发规范</a><a class="text-link" href="/plugin-example.zip" download="chat-notes-1.0.0.zip">示例 ZIP</a></div></section>`:'';}
  async function page(){
    const [catalog,preferences]=await Promise.all([api('/api/plugins'),api('/api/interface-preferences')]),items=catalog.plugins??[];
    const chats=['group','private'].flatMap(kind=>(state.config.wechat.whitelist[kind==='group'?'groups':'private']??[]).map(value=>({key:'wechat:'+kind+':'+value,kind,name:names('wechat:'+kind+':'+value)})));
    const selected=chats.find(chat=>chat.key===state.pluginChat)??chats[0];state.pluginChat=selected?.key;
    const cards=preferences.categories.map(category=>{const members=items.filter(item=>(selected?.kind!=='private'||item.id!=='group-mute')&&pluginCategory(item.id,preferences)===category.id);if(!members.length)return '';return '<section class="plugin-category-group"><h3>'+esc(category.name)+' <small>'+members.length+'</small></h3>'+members.map(item=>{const missing=(item.requestedPermissions??[]).some(value=>!item.permissions.includes(value)),checked=!!selected&&(item.chats===null||item.chats?.includes(selected.key));return '<article class="plugin-assignment-row"><label class="plugin-assignment-toggle"><input type="checkbox" data-plugin-for-chat="'+esc(item.id)+'" '+(checked?'checked':'')+' '+(!selected||item.invalid||missing?'disabled':'')+'><span><strong>'+esc(item.name)+'</strong><small>'+esc(item.description??'')+'</small><small>'+(missing?'需要先授权插件权限':item.enabled?'插件已启用':'总开关关闭，勾选后启用')+'</small></span></label><button class="button small" data-plugin-settings="'+esc(item.id)+'">参数与群聊管理</button><label class="plugin-category-picker">分类<select data-plugin-category="'+esc(item.id)+'">'+preferences.categories.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===category.id?'selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></label></article>';}).join('')+'</section>';}).join('');
    return '<section class="plugin-scope-intro"><div><h2>按聊天选择插件</h2><p>选择群聊或好友，在同一页勾选要使用的插件，修改后自动保存。</p></div><div class="actions"><button class="button" data-plugin-categories>管理分类</button><a class="button" href="#extensions/catalog">插件目录</a></div></section><section class="card"><div class="field"><label for="plugin-chat-picker">当前聊天</label><select id="plugin-chat-picker">'+chats.map(chat=>'<option value="'+esc(chat.key)+'" '+(chat.key===selected?.key?'selected':'')+'>'+esc((chat.kind==='group'?'群聊 · ':'好友 · ')+chat.name)+'</option>').join('')+'</select></div><p id="plugin-assignment-feedback" class="subtle" role="status"></p><div class="plugin-assignment-list">'+(cards||'<p>请先从能力目录安装插件。</p>')+'</div>'+(!chats.length?'<p class="notice">请先在聊天页面添加允许的群聊或好友。</p><a class="button" href="#chats">管理聊天</a>':'')+'</section>';
  }
  function bundleDialog(preview){modal('导入插件总包','<p class="modal-description">新插件保持关闭，不自动授予聊天权限。已安装插件全部跳过，保留你的设置和自定义代码；需要更新时请单独导入对应ZIP。</p><ul>'+preview.plugins.map(p=>'<li>'+esc(p.name)+' · '+esc(p.version)+(p.existing?' · 已安装，将跳过':' · 导入后关闭')+'</li>').join('')+'</ul><p data-bundle-error role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" data-bundle-confirm>确认导入全部新插件</button></div>');document.querySelector('[data-bundle-confirm]').onclick=async event=>{event.currentTarget.disabled=true;try{const result=await api('/api/plugins/bundle/install',{ticket:preview.ticket,revision:preview.revision,confirmed:true});closeModal();await renderPage();toast('已导入'+result.installed+'个，保留已有'+result.skipped+'个'+(result.failed?'，'+result.failed+'个失败，请重新检查':'')+'。');}catch(cause){document.querySelector('[data-bundle-error]').textContent=cause.message;event.target.disabled=false;}};}
  document.addEventListener('change',async event=>{if(event.target.id!=='plugin-bundle-file')return;const file=event.target.files[0];if(!file)return;try{if(file.size>8*1024*1024)throw Error('插件总包不能超过8MB。');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const preview=await api('/api/plugins/bundle/inspect',{name:file.name,zip:btoa(binary)});if(!preview.isBundle)throw Error('这不是插件总包，请用安装ZIP插件入口导入单个插件。');bundleDialog(preview);}catch(cause){toast(cause.message);}});
  async function manageCategories(){try{const preferences=await api('/api/interface-preferences');modal('管理插件分类','<p class="modal-description">分类只整理界面，不改变插件开关、权限和聊天范围。默认分类可改名；删除自建分类后，其中插件移到其他插件。</p>'+preferences.categories.map(c=>'<form data-category-rename="'+esc(c.id)+'" class="category-edit-row"><input aria-label="分类名称" name="category-name" value="'+esc(c.name)+'" maxlength="24" required><button class="button small">保存名称</button>'+(c.id.startsWith('custom-')?'<button type="button" class="button small" data-category-remove="'+esc(c.id)+'">删除分类</button>':'')+'</form>').join('')+'<form data-category-create class="category-edit-row"><input name="category-name" aria-label="新分类名称" placeholder="例如：实验功能" maxlength="24" required><button class="button primary">新建分类</button></form><p data-category-feedback role="status"></p><div class="modal-actions"><button class="button" data-close>完成</button></div>');}catch(cause){toast(cause.message);}}
  async function saveCategory(change){const current=await api('/api/interface-preferences');return api('/api/interface-preferences',{revision:current.revision,...change});}
  document.addEventListener('submit',async event=>{const form=event.target.closest('[data-category-rename],[data-category-create]');if(!form)return;event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await saveCategory({action:form.hasAttribute('data-category-create')?'create':'rename',...(form.dataset.categoryRename?{id:form.dataset.categoryRename}:{}),name:form.elements['category-name'].value});await renderPage();await manageCategories();}catch(cause){const line=document.querySelector('[data-category-feedback]');if(line)line.textContent=cause.message;}finally{if(button.isConnected)button.disabled=false;}});
  document.addEventListener('change',async event=>{const input=event.target.closest('[data-plugin-category]');if(!input)return;input.disabled=true;try{await saveCategory({action:'assign',pluginId:input.dataset.pluginCategory,categoryId:input.value});await renderPage();toast('插件分类已保存。');}catch(cause){toast(cause.message);}finally{if(input.isConnected)input.disabled=false;}});
  const error=message=>{const field=document.querySelector('#plugin-install-error');if(field)field.textContent=message;else toast(message);};
  function installDialog(file){
    sequence++;if(ticket)api('/api/plugins/cancel',{ticket}).catch(()=>{});ticket=null;
    modal('安装 WeChatGirl 插件',`<p class="modal-description">适用于遵循 WeChatGirl API v2 的插件。DSH 插件仍在 DSH 中安装。</p><label class="plugin-dropzone" id="plugin-dropzone" for="plugin-zip"><strong>将一个 ZIP 文件拖到这里</strong><span>或点击选择文件 · 最多 8 MiB</span><input id="plugin-zip" type="file" accept=".zip,application/zip" aria-label="选择 ZIP 插件"></label><div id="plugin-install-preview" aria-live="polite"></div><p id="plugin-install-error" class="inline-error" role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="plugin-install-confirm" disabled>确认安装</button></div>`,{onClose:()=>{sequence++;if(ticket)api('/api/plugins/cancel',{ticket}).catch(()=>{});ticket=null;}});
    document.querySelector('#plugin-zip').addEventListener('change',event=>inspect(event.target.files[0]));
    document.querySelector('#plugin-install-confirm').addEventListener('click',async event=>{
      const preview=document.querySelector('#plugin-install-preview'),replace=preview.querySelector('#plugin-replace');
      if(replace&&!replace.checked){error('请先确认更新同名插件，或取消安装。');return;}
      const button=event.currentTarget;button.disabled=true;
      try{await api('/api/plugins/install',{ticket,revision:preview.dataset.revision,replace:!!replace?.checked});ticket=null;closeModal();await renderPage();toast('插件已安装，尚未启用。点击插件“配置”选择聊天和权限。');}
      catch(cause){error(cause.message);button.disabled=false;}
    });
    if(file)inspect(file);
  }
  async function inspect(file){
    if(!file)return;
    const button=document.querySelector('#plugin-install-confirm'),preview=document.querySelector('#plugin-install-preview');button.disabled=true;preview.textContent='正在检查插件…';error('');
    if(!file.name.toLowerCase().endsWith('.zip')||file.size>8*1024*1024){preview.textContent='';error('请选择不超过 8 MiB 的 ZIP 文件。');return;}
    if(ticket){api('/api/plugins/cancel',{ticket}).catch(()=>{});ticket=null;}
    const request=++sequence;
    try{
      const zip=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取 ZIP 文件。'));reader.readAsDataURL(file);});
      const result=await api('/api/plugins/inspect',{name:file.name,zip});
      if(sequence!==request){api('/api/plugins/cancel',{ticket:result.ticket}).catch(()=>{});return;}
      ticket=result.ticket;preview.dataset.revision=result.revision;
      preview.innerHTML=`<section class="plugin-preview"><h3>${esc(result.plugin.name)} <small>v${esc(result.plugin.version)}</small></h3><p>${esc(result.plugin.description)}</p><small>${esc(result.plugin.id)} · ${result.files} 个文件 · ${Math.ceil(result.bytes/1024)} KiB</small><h4>申请的能力</h4><ul>${result.plugin.permissions.length?result.plugin.permissions.map(value=>`<li>${esc(permissions[value])}</li>`).join(''):'<li>不申请额外宿主权限</li>'}</ul><p class="subtle">安装阶段不会运行代码。插件启用后会执行本地 JavaScript，请只启用信任的来源。</p>${result.installedVersion?`<label class="extension-option"><input id="plugin-replace" type="checkbox">更新已有 v${esc(result.installedVersion)}，保留数据并归档旧代码；更新后需重新启用。</label>`:''}</section>`;
      button.textContent=result.installedVersion?'确认更新':'确认安装';button.disabled=false;
    }catch(cause){if(sequence===request){preview.textContent='';error(cause.message);}}
  }
  function videoMarkup(item,chats){
    const authorized=chats.filter(key=>item.chats===null||item.chats?.includes(key));
    return `<fieldset class="extension-fieldset" data-video-panel><legend>视频工作台</legend>
      <p class="subtle">授权群聊无需艾特。缓存缺失时，程序会尝试打开唯一可确认的视频，可能切换微信前台窗口。下载后自动识别、回复并核对微信服务器回执。等待缓存最长约 5 分钟。</p>
      <p class="subtle">下方手动压缩与测试支持 32 MiB、3 分钟以内的视频。</p>
      <label class="field">应用聊天的模型与权限<select data-video-chat>${authorized.map(key=>`<option value="${esc(key)}">${esc(names(key))}</option>`).join('')}</select></label>
      <label class="field">选择视频<input type="file" accept=".mp4,.mov,.m4v,.webm,.mkv" data-video-file></label>
      <div class="button-row">
        <button type="button" class="button primary" data-video-action="compress">压缩为 MP4</button>
        <button type="button" class="button" data-video-action="recognize">识别视频画面</button>
        <button type="button" class="button" data-video-cancel hidden>取消处理</button>
        <a class="button" data-video-download download="wechatgirl-compressed.mp4" hidden>下载压缩视频</a>
      </div>
      <p data-video-status role="status">${!item.enabled||!authorized.length?'请先启用插件、选择聊天并保存。':''}</p>
      <p data-video-result class="subtle"></p>
    </fieldset>`;
  }
  function bindVideoPanel(form,item){
    const panel=form.querySelector('[data-video-panel]');
    const file=panel.querySelector('[data-video-file]'),chat=panel.querySelector('[data-video-chat]');
    const status=panel.querySelector('[data-video-status]'),result=panel.querySelector('[data-video-result]');
    const download=panel.querySelector('[data-video-download]'),cancel=panel.querySelector('[data-video-cancel]');
    const buttons=[...panel.querySelectorAll('[data-video-action]')];
    let controller,objectUrl;
    const reset=()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=undefined;download.hidden=true;result.textContent='';};
    const paint=()=>{for(const button of buttons)button.disabled=!!controller||!item.enabled||!chat.value;cancel.hidden=!controller;file.disabled=chat.disabled=!!controller;};
    for(const button of buttons)button.onclick=async()=>{
      const source=file.files[0],format=source?.name.split('.').at(-1)?.toLowerCase();
      if(controller)return;
      if(!source||source.size>32*1024*1024)return void(status.textContent='请选择 32 MB 以内的视频。');
      const action=button.dataset.videoAction;
      controller=new AbortController();reset();paint();
      status.textContent=action==='compress'?'正在本机压缩视频…':'正在提取画面并调用 DSH 识图…';
      try{
        const query=new URLSearchParams({key:chat.value,action,format});
        const value=await api('/api/video-workbench?'+query,source,true,{binary:true,signal:controller.signal});
        if(!panel.isConnected)return;
        if(value.video){
          const bytes=Uint8Array.from(atob(value.video),c=>c.charCodeAt(0));
          objectUrl=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
          download.href=objectUrl;download.hidden=false;
          status.textContent=value.smaller?'压缩完成，可以下载。':'已转为 MP4，结果没有比原文件小。';
          result.textContent=`原文件 ${(value.sourceBytes/1048576).toFixed(2)} MB · 输出 ${(value.size/1048576).toFixed(2)} MB`;
        }else{
          status.textContent=`识别完成 · ${value.model.provider} / ${value.model.model} · 最多 ${value.frames} 帧`;
          const audio=value.audio;
          const statusLabel={no_audio:'无音轨',missing_model:'本机 SenseVoice 未安装',no_speech:'未转写到清楚的对白',too_long:'超过本机单次整段转写的 5 分钟上限',failed:'整段音轨转写失败'}[audio?.status];
          result.style.whiteSpace='pre-wrap';
          result.textContent='画面抽样：'+value.text+(audio?.status==='ready'?'\n\n整段音轨转写：'+audio.text:statusLabel?'\n\n音轨：'+statusLabel:'');
        }
      }catch(error){if(panel.isConnected)status.textContent=controller.signal.aborted?'处理已取消。':error.name==='TimeoutError'?'处理超时，请缩短视频后重试。':error.message;}
      finally{controller=undefined;if(panel.isConnected)paint();}
    };
    cancel.onclick=()=>controller?.abort();
    file.onchange=reset;chat.onchange=()=>{reset();paint();};
    paint();
    return ()=>{controller?.abort();reset();};
  }
  function bindVideoModels(form){
    const select=form.querySelector('[data-plugin-setting="visionModel"]');
    const search=form.querySelector('[data-video-model-filter]');
    const status=form.querySelector('[data-video-model-status]');
    const refresh=form.querySelector('[data-video-model-refresh]');
    let rows=[];
    function paint(){
      const saved=select.value||'{}',term=search.value.trim().toLowerCase();
      const matches=rows.filter(row=>[row.provider,row.providerName,row.model,row.name].join(' ').toLowerCase().includes(term));
      select.innerHTML='<option value="{}">跟随聊天与图片分流</option>'+visionModelGroups(matches).filter(group=>group.models.length).map(group=>
        '<optgroup label="'+esc(group.label)+'">'+group.models.map(row=>'<option '+(group.disabled?'disabled ':'')+'value="'+esc(JSON.stringify({provider:row.provider,model:row.model}))+'">'+esc((row.providerName??row.provider)+' / '+row.model)+'</option>').join('')+'</optgroup>').join('');
      if(![...select.options].some(option=>option.value===saved)){
        const {provider,model}=JSON.parse(saved);
        select.add(new Option(provider+' / '+model+'（当前选择）',saved));
      }
      select.value=saved;
    }
    async function load(){
      refresh.disabled=true;status.textContent='正在从 DSH 读取模型…';
      try{const catalog=await api('/api/dsh-models');if(!select.isConnected)return;rows=catalog.models??[];paint();status.textContent=catalog.available?'已读取 DSH 模型。指定模型仅用于视频画面识别。':catalog.message;}
      catch(error){if(select.isConnected)status.textContent=error.message;}
      finally{if(refresh.isConnected)refresh.disabled=false;}
    }
    search.oninput=paint;refresh.onclick=()=>void load();void load();
  }
  function videoModelField(value){
    return `<div class="field full"><label for="video-model">视频识别模型</label><input type="search" aria-label="搜索视频识别模型" placeholder="搜索提供方或模型" data-video-model-filter><select id="video-model" data-plugin-setting="visionModel"><option value="${esc(JSON.stringify(value||{}))}">${value?.model?esc(value.provider+' / '+value.model):'跟随聊天与图片分流'}</option></select><button class="button small" type="button" data-video-model-refresh>刷新 DSH 模型</button><small data-video-model-status role="status"></small><small>可指定独立的识图模型。跟随聊天时，支持图片的聊天模型直接读抽帧拼图，纯文本模型使用备用识图模型。</small></div>`;
  }
  function mountVideo(host){
    const id='video-workbench';
    const chats=['private','group'].flatMap(kind=>(state.config.wechat.whitelist[kind==='group'?'groups':'private']??[]).map(value=>'wechat:'+kind+':'+value));
    let disposed=false,disposePanel;
    const select=(key,label,choices,value,description)=>`<label class="field">${esc(label)}<select name="${key}">${choices.map(option=>`<option value="${option}" ${option===value?'selected':''}>${option}</option>`).join('')}</select><small>${esc(description)}</small></label>`;
    async function load(){
      try{
        const catalog=await api('/api/plugins');
        if(disposed||!host.isConnected)return;
        const item=catalog.plugins.find(entry=>entry.id===id);
        const intro=`<section class="card"><h2>微信里的视频怎么识别</h2><ol><li>启用插件，选择允许自动识别的好友和群聊。</li><li>授权群聊发视频后自动下载和识别，无需艾特。</li><li>DSH 分析各段的画面，本机 SenseVoice 单独识别整段音轨。音轨整段转写支持 5 分钟以内，超过时仍可识别画面。</li></ol></section>`;
        if(!item||item.invalid){
          host.innerHTML=intro+`<section class="card"><h2>${item?'插件需要修复':'安装视频插件'}</h2><p>${esc(item?.reason??'请在能力目录导入「视频压缩与识别」插件 ZIP，再返回这里启用。')}</p><a class="button" href="#extensions/catalog">前往能力目录</a></section>`;
          return;
        }
        const {settings}=item;
        host.innerHTML=intro+`<form class="section-stack" data-video-settings>
          <section class="card"><h2>自动识别与聊天授权</h2><label class="extension-option"><input type="checkbox" name="enabled" ${item.enabled?'checked':''}>启用视频插件</label>
          <label class="extension-option"><input type="checkbox" name="allChats" ${item.chats===null?'checked':''}>所有允许的聊天（含以后添加的聊天）</label>
          <fieldset class="extension-fieldset" data-video-chat-scope><legend>选择好友与群聊</legend>
          ${chats.map(key=>`<label class="extension-option"><input type="checkbox" name="chat" value="${esc(key)}" ${item.chats===null||item.chats?.includes(key)?'checked':''}>${key.includes(':group:')?'群聊':'好友'} · ${esc(names(key))}</label>`).join('')||'<p class="subtle">还没有可授权的聊天。</p><a class="button small" href="#chats">添加聊天</a>'}</fieldset></section>
          <section class="card"><h2>识别模型与画面分段</h2><div class="form-grid">
          ${videoModelField(settings.visionModel)}
          <label class="field">画面识别分段数量<input type="number" name="sampleFrames" min="2" max="16" step="1" value="${esc(settings.sampleFrames??6)}" required><small>全片按时间等分，每段取一帧。默认 6 段。增加段数可以看到更多画面，也会延长处理时间。音轨独立识别。</small></label></div></section>
          <section class="card"><h2>手动压缩设置</h2><div class="form-grid">
          ${select('resolution','分辨率上限（像素）',[480,720,1080],settings.resolution??720,'按原画面比例缩小，保留首条音轨。')}
          <label class="field">压缩强度（CRF）<input type="number" name="quality" min="20" max="34" step="1" value="${esc(settings.quality??26)}" required><small>数值越大，成品通常越小。默认 26。这两项只用于手动压缩。</small></label></div></section>
          <div class="button-row"><button type="submit" class="button primary">保存视频设置</button><p class="subtle" data-video-save-status role="status"></p></div>
          </form><section class="card"><h2>本地测试与压缩</h2><p class="subtle">使用已保存的配置。测试在本页显示结果，可能消耗 DSH 模型额度。</p>${videoMarkup(item,chats)}</section>`;
        const form=host.querySelector('[data-video-settings]'),status=form.querySelector('[data-video-save-status]');
        let revision=catalog.revision;
        const scope=()=>{form.querySelector('[data-video-chat-scope]').disabled=form.elements.allChats.checked;};
        function mountTools(){
          disposePanel?.();
          const panel=host.querySelector('[data-video-panel]');
          const template=document.createElement('template');
          template.innerHTML=videoMarkup(item,chats).trim();
          panel.replaceWith(template.content.firstElementChild);
          disposePanel=bindVideoPanel(host,item);
        }
        scope();form.elements.allChats.onchange=scope;
        bindVideoModels(form);
        disposePanel=bindVideoPanel(host,item);
        form.onsubmit=async event=>{
          event.preventDefault();
          const button=event.submitter;
          if(button.disabled)return;
          button.disabled=true;status.textContent='正在保存…';
          try{
            const enabled=form.elements.enabled.checked;
            const nextChats=form.elements.allChats.checked?null:[...form.querySelectorAll('[name="chat"]:checked')].map(input=>input.value);
            const values={...item.settings,sampleFrames:Number(form.elements.sampleFrames.value),
              resolution:Number(form.elements.resolution.value),quality:form.elements.quality.valueAsNumber,
              visionModel:JSON.parse(form.querySelector('[data-plugin-setting="visionModel"]').value)};
            const updated=await api('/api/plugins/'+id,{revision,enabled,permissions:item.permissions,chats:nextChats,settings:values});
            if(disposed)return;
            revision=updated.revision;
            Object.assign(item,{enabled,chats:nextChats,settings:values});
            mountTools();status.textContent='已保存，下一条视频按新设置处理。';
          }catch(error){if(!disposed)status.textContent=error.message;}
          finally{if(!disposed)button.disabled=false;}
        };
      }catch(error){
        if(disposed||!host.isConnected)return;
        host.innerHTML=`<section class="card"><p role="alert">${esc(error.message)}</p><button type="button" class="button">重新读取</button></section>`;
        host.querySelector('button').onclick=()=>void load();
      }
    }
    void load();
    return ()=>{disposed=true;disposePanel?.();};
  }
  async function settings(id){
    if(id==='video-workbench'){location.hash='#video';return;}
    try{
      const catalog=await api('/api/plugins'),item=catalog.plugins.find(item=>item.id===id);if(!item)throw Error(BUILTIN_PLUGIN_PACKAGES.some(bundle=>bundle.id===id)?'该内置插件尚未安装，请先到能力目录安装，再返回配置。':'插件已变化，请刷新列表。');
      const chats=(id==='group-mute'?['group']:['private','group']).flatMap(kind=>(state.config.wechat.whitelist[kind==='group'?'groups':'private']??[]).map(value=>'wechat:'+kind+':'+value));
      const isSpeech=item.id==='speech-recognition';let speechBinding;
      const renderField=([key,schema],index)=>{
        const value=item.settings[key]??schema.default??'',field='plugin-setting-'+index,label=esc(schema.title??key),attr=`id="${field}" data-plugin-setting="${esc(key)}"`;
        if(['voice-studio','local-voice-model'].includes(item.id)&&key==='localModelPath')return `<div class="field"><label for="${field}">${label}</label><input ${attr} value="${esc(value)}" placeholder="留空使用内置模型"><small>${esc(schema.description??'')}</small>${window.desktop?.chooseVoiceModel?'<button type="button" class="button small" data-choose-voice-model>选择本地模型文件</button>':''}</div>`;
        if(isSpeech&&key==='model')return speechModelField({attr,field,label,value,esc});
        if(isSpeech&&key==='apiProtocol')return speechProtocolField({attr,field,schema,value,esc});
        if(id==='group-mute'&&key==='extraOperators')return `<div class="field"><label for="${field}">${label}</label><textarea ${attr} rows="3" spellcheck="false">${esc((Array.isArray(value)?value:[]).join('\n'))}</textarea><small>${esc(schema.description)}</small></div>`;
        if(schema.type==='boolean')return `<label class="extension-option"><input ${attr} type="checkbox" ${value?'checked':''}><span class="plugin-setting-copy">${label}${schema.description?`<small>${esc(schema.description)}</small>`:''}</span></label>`;
        if(schema.enum)return `<div class="field"><label for="${field}">${label}</label><select ${attr}>${schema.enum.map((option,n)=>`<option value="${n}" ${option===value?'selected':''}>${esc(({preview:"1分钟片段 · 最多60秒",full:"完整翻唱 · 每段最长55秒",breeze:"Breeze · 参考克隆",cosyvoice:"CosyVoice3 · 专用肥鱼引擎"})[option]??option)}</option>`).join('')}</select><small>${esc(schema.description??'')}</small></div>`;
        if(['object','array'].includes(schema.type))return `<div class="field"><label for="${field}">${label}（JSON）</label><textarea ${attr}>${esc(JSON.stringify(value,null,2))}</textarea></div>`;
        return `<div class="field"><label for="${field}">${label}</label><input ${attr} type="${schema.secret?'password':['integer','number'].includes(schema.type)?'number':'text'}" value="${esc(value)}" ${Number.isFinite(schema.minimum)?`min="${schema.minimum}"`:''} ${Number.isFinite(schema.maximum)?`max="${schema.maximum}"`:''} ${schema.type==='integer'?'step="1"':schema.type==='number'?'step="any"':''} ${schema.secret?'placeholder="留空保留已保存值" autocomplete="off"':''}><small>${esc(schema.description??'')}</small></div>`;
      };
      const basic=new Set(['apiProtocol','endpoint','apiKey','model','language','audioFormat','autoReadModels']);
      const rows=Object.entries(item.configSchema).map((entry,index)=>({key:entry[0],html:renderField(entry,index)}));
      const memoryGroups=[['自动记录与共享',['autoRemember','allowCrossChat','rememberNickname','rememberPreference','rememberPet','rememberProject','rememberActivity','rememberPlan']],['召回与近期上下文',['autoRecall','archiveRecall','recallLimit','recallPeopleLimit','contextBudget','recentMessages','recentChars','coldWakeMinutes']],['保留期限与后台摘要',['nicknameRetentionDays','factRetentionDays','planRetentionDays','maxNotesPerPerson','autoSummary','summaryTriggerRecords','summaryCooldownSeconds','allowEvaluation']]];
      const settingsMarkup=item.id==='people-memory'?memoryGroups.map(([title,keys],i)=>`<details class="speech-advanced" ${i===0?'open':''}><summary>${esc(title)}</summary><div class="form-grid">${rows.filter(row=>keys.includes(row.key)).map(row=>row.html).join('')}</div></details>`).join(''):isSpeech?'<div class="form-grid">'+rows.filter(row=>basic.has(row.key)).map(row=>row.html).join('')+'</div>'+speechDiagnosticsMarkup(item.serviceStatus,esc)+'<details class="speech-advanced"><summary>高级请求与模型列表设置</summary><div class="form-grid">'+rows.filter(row=>!basic.has(row.key)).map(row=>row.html).join('')+'</div></details>':'<div class="form-grid">'+rows.map(row=>row.html).join('')+'</div>';
      modal(item.name,`<form id="plugin-settings-form"><p class="modal-description">${esc(item.description)}</p><p class="modal-description">${esc(item.reason)}。${id==='group-mute'?'保存后立即生效。只在勾选的群聊响应静音命令。':'保存后在空闲时或下一轮聊天加载；首次使用 API v2 需重开 DSH。允许哪些聊天使用，请在插件与聊天页面单独选择。'}</p><label class="extension-option"><input id="plugin-enabled" type="checkbox" ${item.enabled?'checked':''} ${item.invalid?'disabled':''}>允许此插件运行（仅启用信任的代码）</label><fieldset class="extension-fieldset"><legend>授权能力</legend>${item.requestedPermissions.map(value=>`<label class="extension-option"><input name="plugin-permission" type="checkbox" value="${esc(value)}" ${item.permissions.includes(value)?'checked':''}>${esc(permissions[value])}</label>`).join('')||'<p class="subtle">不需要额外权限。</p>'}</fieldset><fieldset class="extension-fieldset"><legend>插件群聊与好友管理</legend>${chats.map(key=>`<label class="extension-option"><input name="plugin-chat" type="checkbox" value="${esc(key)}" ${item.chats===null||item.chats?.includes(key)?'checked':''}>${esc(names(key))}</label>`).join('')||'<p>请先添加允许的聊天。</p>'}</fieldset>${item.id==='memory-retrieval'?'<p class="notice plain">关键词检索需要「读取聊天历史」权限，并勾选允许检索的聊天。语义检索还需要嵌入权限和可用的本机模型服务。首次建立完整档案索引后再查询，或关闭完整档案检索以查询近期记录。</p>':''}${settingsMarkup}${item.id==='group-behavior'?'<section class="speech-advanced"><h3>虚构场景回放</h3><p class="subtle">不保存设置、不调用模型、不发送微信。</p><button type="button" class="button" data-group-replay>回放：点名 → 5秒后闲聊 → 再次点名</button><p data-group-replay-result role="status"></p></section>':''}<p class="inline-error" id="plugin-settings-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存插件设置</button></div></form>`,{onClose:()=>{speechBinding?.dispose();}});
      const form=document.querySelector('#plugin-settings-form');
      form.querySelector('[data-choose-voice-model]')?.addEventListener('click',async()=>{try{const chosen=await window.desktop.chooseVoiceModel();if(chosen)form.querySelector('[data-plugin-setting="localModelPath"]').value=chosen;}catch(error){form.querySelector('#plugin-settings-error').textContent=error.message;}});
      const readValues=()=>{const values={...item.settings};for(const input of form.querySelectorAll('[data-plugin-setting]')){const key=input.dataset.pluginSetting,schema=item.configSchema[key];values[key]=id==='group-mute'&&key==='extraOperators'?[...new Set(input.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean))]:schema.enum?schema.enum[Number(input.value)]:schema.type==='boolean'?input.checked:['object','array'].includes(schema.type)?JSON.parse(input.value):['integer','number'].includes(schema.type)?Number(input.value):input.value;}
        if(id==='group-mute'&&(values.extraOperators.some(wxid=>!/^[A-Za-z0-9_-]{1,128}$/.test(wxid))||values.defaultMinutes>values.maxMinutes))throw Error('请每行填写一个真实微信 ID，并使默认时间不超过单次上限。');return values;};
      form.querySelector('[data-group-replay]')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const result=await api('/api/group-behavior/replay',{settings:readValues()});form.querySelector('[data-group-replay-result]').textContent=result.results.map((row,index)=>['直接点名','5秒后闲聊','再次点名'][index]+'：'+(row.reply?'接话':'暂不接话')+'（'+({'direct-request':'直接请求','cooldown':'冷却中','ambient-sampling':'本轮随机旁听','ambient-allowed':'允许自然接话'}[row.reason]??row.reason)+'）').join('；');}catch(error){form.querySelector('[data-group-replay-result]').textContent=error.message;}finally{button.disabled=false;}});
      if(isSpeech)speechBinding=bindSpeechSettings({form,api:(route,body,options)=>api(route,body,true,options),item,revision:catalog.revision,readValues,esc});
      form.addEventListener('submit',async event=>{event.preventDefault();speechBinding?.cancel();const button=event.submitter??form.querySelector('[type="submit"]');button.disabled=true;
        try{
          const values=readValues();
          await api('/api/plugins/'+item.id,{revision:catalog.revision,enabled:form.querySelector('#plugin-enabled').checked,permissions:[...form.querySelectorAll('[name="plugin-permission"]:checked')].map(input=>input.value),chats:[...form.querySelectorAll('[name="plugin-chat"]:checked')].map(input=>input.value),settings:values});closeModal();await renderPage();toast('插件设置已保存。');
        }catch(cause){form.querySelector('#plugin-settings-error').textContent=cause.message;button.disabled=false;}
      });
    }catch(cause){toast(cause.message);}
  }
  document.addEventListener('click',async event=>{
    const downloadBundle=event.target.closest('[data-plugin-bundle-download]');if(downloadBundle){downloadBundle.disabled=true;try{const preview=await api('/api/plugins/bundle/download',{confirmed:true});bundleDialog(preview);}catch(cause){toast(cause.message);}finally{if(downloadBundle.isConnected)downloadBundle.disabled=false;}return;}
    const classify=event.target.closest('[data-plugin-reclassify]');if(classify){try{const preferences=await api('/api/interface-preferences'),id=classify.dataset.pluginReclassify;modal('调整插件分类','<p class="modal-description">仅改变整理位置，不改变权限和聊天范围。</p><label class="field">分类<select data-reclassify-value>'+preferences.categories.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===pluginCategory(id,preferences)?'selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></label><p data-reclassify-error role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" data-reclassify-save>保存分类</button></div>');document.querySelector('[data-reclassify-save]').onclick=async e=>{e.currentTarget.disabled=true;try{await saveCategory({action:'assign',pluginId:id,categoryId:document.querySelector('[data-reclassify-value]').value});closeModal();await renderPage();}catch(cause){document.querySelector('[data-reclassify-error]').textContent=cause.message;e.target.disabled=false;}};}catch(cause){toast(cause.message);}return;}
    if(event.target.closest('[data-plugin-categories]')){await manageCategories();return;}const remove=event.target.closest('[data-category-remove]');if(remove){confirmAction('删除分类','其中插件会移到其他插件，插件和数据保留。','删除分类',async()=>{await saveCategory({action:'remove',id:remove.dataset.categoryRemove});await renderPage();await manageCategories();});return;}
    const scopeAction=event.target.closest('[data-scope-select]');if(scopeAction){const form=document.querySelector('#plugin-scope-form');for(const input of form?.querySelectorAll('[name="plugin-scope-chat"]')??[])input.checked=scopeAction.dataset.scopeSelect==='all';form?.querySelector('#plugin-scope-selected-count')?.replaceChildren(String(form.querySelectorAll('[name="plugin-scope-chat"]:checked').length));return;}
    const button=event.target.closest('[data-plugin-install],[data-plugin-settings],[data-plugin-uninstall]');if(!button)return;
    if(button.hasAttribute('data-plugin-install'))installDialog();
    if(button.dataset.pluginSettings)settings(button.dataset.pluginSettings);
    if(button.dataset.pluginUninstall){const id=button.dataset.pluginUninstall;const catalog=await api('/api/plugins').catch(()=>null);if(!catalog)return toast('无法读取插件列表，请重试。');confirmAction('卸载插件','插件代码会归档，保存的数据保留。','卸载',async()=>{try{await api('/api/plugins/'+id+'/uninstall',{revision:catalog.revision});await renderPage();toast('插件已卸载，数据已保留。');}catch(cause){toast(cause.message);}});}
  });
  document.addEventListener('change',async event=>{
    if(event.target.id==='plugin-chat-picker'){state.pluginChat=event.target.value;await renderPage();return;}
    const input=event.target.closest('[data-plugin-for-chat]');if(!input)return;
    const key=state.pluginChat,desired=input.checked;input.disabled=true;const feedback=document.querySelector('#plugin-assignment-feedback');if(feedback)feedback.textContent='正在保存…';
    try{const catalog=await api('/api/plugins'),item=catalog.plugins.find(item=>item.id===input.dataset.pluginForChat);if(!item)throw Error('插件已变化，请刷新。');const all=['private','group'].flatMap(kind=>(state.config.wechat.whitelist[kind==='group'?'groups':'private']??[]).map(value=>'wechat:'+kind+':'+value)),chats=new Set(item.chats===null?all:(item.chats??[]));if(desired)chats.add(key);else chats.delete(key);await api('/api/plugins/'+item.id,{revision:catalog.revision,enabled:item.enabled||desired,permissions:item.permissions,chats:[...chats],settings:item.settings});if(feedback)feedback.textContent='已保存，本聊天的插件范围已更新。';}catch(error){input.checked=!desired;if(feedback)feedback.textContent=error.message;}finally{input.disabled=false;}
  });
  document.addEventListener('change',event=>{if(!event.target.matches('#plugin-scope-form [name="plugin-scope-chat"]'))return;const count=document.querySelector('#plugin-scope-selected-count');if(count)count.textContent=String(document.querySelectorAll('#plugin-scope-form [name="plugin-scope-chat"]:checked').length);});
  document.addEventListener('submit',async event=>{const form=event.target.closest('#plugin-scope-form');if(!form)return;event.preventDefault();const button=form.querySelector('[type="submit"]'),id=location.hash.replace(/^#plugins\//,'').split('/')[0];button.disabled=true;try{const catalog=await api('/api/plugins'),item=catalog.plugins.find(value=>value.id===id);if(!item)throw Error('插件已变化，请刷新页面。');const chats=[...form.querySelectorAll('[name="plugin-scope-chat"]:checked')].map(input=>input.value);await api('/api/plugins/'+id,{revision:catalog.revision,enabled:item.enabled||chats.length>0,permissions:item.permissions??[],chats,settings:item.settings??{}});await renderPage();toast('插件可用聊天已保存。');}catch(cause){form.querySelector('#plugin-scope-error').textContent=cause.message;button.disabled=false;}});
  document.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files')&&(document.querySelector('#plugin-install-entry')||document.querySelector('#plugin-dropzone'))){event.preventDefault();document.querySelector('#plugin-install-entry')?.classList.add('is-dragover');}});
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget)document.querySelector('#plugin-install-entry')?.classList.remove('is-dragover');});
  document.addEventListener('drop',event=>{if(!document.querySelector('#plugin-install-entry')&&!document.querySelector('#plugin-dropzone'))return;event.preventDefault();document.querySelector('#plugin-install-entry')?.classList.remove('is-dragover');const files=event.dataTransfer?.files;if(files?.length!==1)return toast('一次拖入一个 ZIP 插件即可。');installDialog(files[0]);});
  return {installMarkup,settings,installDialog,page,mountVideo};
}
