// Vendor app.asar files are opaque program files. Electron's patched fs
// interprets them as virtual directories, including incomplete destinations.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function upgradeBundledVoiceStudio(workspace,bundle){
  const {pathToFileURL}=require('node:url');
  const api=relative=>import(pathToFileURL(path.join(workspace,'packages/plugin-api',relative)).href);
  const {inspectPackage,directory}=await api('catalog.mjs');
  const target=path.join(workspace,'plugins','voice-studio');
  if(!fs.existsSync(target)||fs.lstatSync(path.dirname(target)).isSymbolicLink())return false;
  let current;try{current=inspectPackage(target);}catch{return false;}
  // Only update the official 1.4.1 payload. Keep customised plugins and all existing permissions/settings.
  if(current.revision!=='b1c8148991222c4a5c82c777c9fe46453cf2992d1c51cb6dc3fe05ec068abe0e')return false;
  const {unpackZip}=await api('zip.mjs');
  const parent=directory(workspace,'state/plugin-archives');
  const staged=fs.mkdtempSync(path.join(parent,'voice-studio-upgrade-'));
  try{
    for(const file of unpackZip(fs.readFileSync(path.join(workspace,bundle.zip)))){
      const destination=path.join(staged,file.name);
      fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,file.data,{flag:'wx'});
    }
    const next=inspectPackage(staged);
    if(next.id!=='voice-studio'||next.version!==bundle.version||
      JSON.stringify(next.permissions)!==JSON.stringify(current.permissions)||
      JSON.stringify(next.settings)!==JSON.stringify(current.settings)||
      JSON.stringify(next.configSchema)!==JSON.stringify(current.configSchema))throw Error('声音工作室迁移清单不兼容。');
    const backup=path.join(parent,'voice-studio-1.4.1-'+crypto.randomUUID());
    fs.renameSync(target,backup);
    try{fs.renameSync(staged,target);}catch(error){fs.renameSync(backup,target);throw error;}
    return true;
  }finally{fs.rmSync(staged,{recursive:true,force:true});}
}

async function bootstrapDeployment(resourcesPath, dataHome, progress = () => {}, options = {}) {
  const template = path.join(resourcesPath, 'project');
  const manifestFile = path.join(template, 'deployment.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const wechatVersion=manifest.wechatVersion??'4.1.10.27';
  if(!['4.1.10.27','4.1.15.13'].includes(wechatVersion))throw new Error('发行包微信版本无效。');
  const currentSender=wechatVersion==='4.1.15.13';
  const dshBundled = manifest.dshBundled !== false;
  const workspace = path.join(dataHome, 'workspace');
  const firstInstall = !fs.existsSync(path.join(workspace,'config/wechatagent.json'));
  const previousDistribution=path.join(workspace,'config/distribution.json');
  const previousSettings=fs.existsSync(previousDistribution)?JSON.parse(fs.readFileSync(previousDistribution,'utf8').replace(/^\uFEFF/,'')):{};
  const bundledPlugins=new Set(Array.isArray(previousSettings.bundledPlugins)?previousSettings.bundledPlugins:[]);
  const includesAll=manifest.pluginDistribution==='all';
  const bundledIds=includesAll?manifest.bundledPlugins:manifest.essentialPlugins;
  const defaultPlugins=new Set(Array.isArray(previousSettings.defaultPlugins)?previousSettings.defaultPlugins:[]);
  const externalDshHome=options.externalDshHome || previousSettings.externalDshHome || process.env.DSH_HOME || path.join(require('node:os').homedir(),'.dsh');
  const dshHome=options.dshHome || previousSettings.dshHome || (dshBundled && !fs.existsSync(path.join(workspace,'config/wechatagent.json')) ? path.join(dataHome,'dsh') : externalDshHome);
  fs.mkdirSync(workspace, { recursive: true });
  for (const relative of manifest.files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.startsWith('state/') || relative === 'config/wechatagent.json') throw new Error('发行包文件清单无效。');
    const source = path.join(template, relative), target = path.join(workspace, relative);
    if (relative.startsWith('roles/')) {
      if (fs.existsSync(target)) continue;
      const name=path.basename(relative,'.md'),key=crypto.createHash('sha256').update(name.toLocaleLowerCase()).digest('hex');
      const marker=path.join(workspace,'state','deleted-personas',key+'.json');
      try {
        const record=JSON.parse(fs.readFileSync(marker,'utf8'));
        if(record.version===1&&typeof record.name==='string'&&record.name.toLocaleLowerCase()===name.toLocaleLowerCase())continue;
      } catch { /* Missing/invalid markers retain the existing seed behaviour. */ }
    }
    const bytes = fs.readFileSync(source);
    if (fs.existsSync(target) && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === crypto.createHash('sha256').update(bytes).digest('hex')) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const runtimeName = manifest.runtimeRevision ? `${manifest.version}-${manifest.runtimeRevision}` : manifest.version;
  const versionRuntime = path.join(dataHome, 'runtimes', runtimeName);
  const ready = path.join(versionRuntime, '.ready');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(versionRuntime, { recursive: true });
    progress('正在准备内置 Python 运行环境…');
    await fs.promises.cp(path.join(resourcesPath, 'runtime', 'python'), path.join(versionRuntime, 'python'), { recursive: true });
    progress(dshBundled?'正在准备 Node.js 与模型程序…':'正在准备 Node.js 运行环境…');
    fs.copyFileSync(path.join(resourcesPath, 'runtime', 'node.exe'), path.join(versionRuntime, 'node.exe'));
    if(dshBundled)await fs.promises.cp(path.join(resourcesPath, 'vendor', 'dsh'), path.join(versionRuntime, 'dsh'), { recursive: true });
    fs.writeFileSync(ready, manifest.version);
  }
  const python = path.join(versionRuntime, 'python', 'python.exe');
  const node = path.join(versionRuntime, 'node.exe');
  // Keep an existing legacy executable/data binding; new installations choose
  // an independently installed DSH through the setup page.
  const dsh = dshBundled ? path.join(versionRuntime,'dsh','DeepSeek Harness.exe') : previousSettings.dsh || '';
  const client = path.join(workspace, 'state', 'hook', 'wechat-'+wechatVersion);
  if (!fs.existsSync(path.join(client, 'Weixin.exe'))) {
    progress('正在准备独立匹配微信…');
    fs.mkdirSync(path.dirname(client), { recursive: true }); await fs.promises.cp(path.join(resourcesPath, 'vendor', 'wechat'), client, { recursive: true });
  }
  const nativeDir = path.join(workspace, 'state', 'hook', currentSender?'native-4.1.15.13':'native');
  const nativeSource=path.join(resourcesPath,'vendor',currentSender?'hook-current':'hook');
  const nativeFiles=currentSender?['wechatagent-text-4.1.15.13.dll','wechatagent-text-loader.exe','build.json']:['version.dll','build.json'];
  if(currentSender){
    const build=JSON.parse(fs.readFileSync(path.join(nativeSource,'build.json'),'utf8').replace(/^\uFEFF/,''));
    const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(nativeSource,file))).digest('hex');
    if(build.targetVersion!==wechatVersion||build.profile!=='4.1.15.13-media-mentions-v2'||build.loaderInit!=='worker-path-v1'||build.voiceProfile!=='recording-factory-v1'||
      hash(nativeFiles[0])!==build.sha256||hash(nativeFiles[1])!==build.loaderSha256)throw new Error('发行包微信发送组件校验失败。');
  }
  fs.mkdirSync(nativeDir, { recursive: true });
  const previousBuild = path.join(nativeDir,'build.json');
  if (!currentSender && fs.existsSync(previousBuild) && fs.existsSync(path.join(nativeDir,'version.dll'))) {
    const installedHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(nativeDir,'version.dll'))).digest('hex');
    const nextHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(resourcesPath,'vendor/hook/version.dll'))).digest('hex');
    if (installedHash !== nextHash) {
      const previous=JSON.parse(fs.readFileSync(previousBuild,'utf8').replace(/^\uFEFF/,''));
      if (previous.sha256 === installedHash) fs.copyFileSync(previousBuild,path.join(nativeDir,'build.previous.json'));
    }
  }
  for (const file of nativeFiles) {
    const source = path.join(nativeSource, file), target = path.join(nativeDir, file);
    const bytes = fs.readFileSync(source);
    if (!fs.existsSync(target) || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== crypto.createHash('sha256').update(bytes).digest('hex')) fs.writeFileSync(target,bytes);
  }
  const configFile = path.join(workspace, 'config', 'wechatagent.json');
  if (!fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'config', 'wechatagent.example.json'), 'utf8'));
    config.runtime.python = python;
    config.runtime.dshDesktop = dshBundled ? dsh : '';
    config.hook={...config.hook,expectedVersion:wechatVersion,wechatExecutable:path.relative(workspace,path.join(client,'Weixin.exe'))};
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  }
  if(Array.isArray(bundledIds)&&bundledIds.length){
    progress('正在准备基础插件…');
    const {pathToFileURL}=require('node:url');
    const {PluginInstaller}=await import(pathToFileURL(path.join(workspace,'packages/plugin-api/installer.mjs')).href);
    const {BUNDLED_PLUGINS}=await import(pathToFileURL(path.join(workspace,'packages/plugin-api/bundled.mjs')).href);
    const {updatePlugin}=await import(pathToFileURL(path.join(workspace,'packages/plugin-api/catalog.mjs')).href);
    const installer=new PluginInstaller(workspace);
    try{
      for(const id of bundledIds){
        const bundle=BUNDLED_PLUGINS.find(b=>b.id===id&&(includesAll||b.essential)&&b.zip);
        if(!bundle)throw Error('基础插件登记无效。');
        if(id==='group-mute'&&bundle.version==='1.1.0'){
          // Upgrade only the original built-in manifest. Keep its permissions, chat scope and enabled state.
          const pluginDir=path.join(workspace,'plugins',id),target=path.join(pluginDir,'plugin.json');
          if(fs.existsSync(target)&&[path.dirname(pluginDir),pluginDir,target].every(file=>!fs.lstatSync(file).isSymbolicLink())&&
            fs.statSync(target).isFile()&&fs.statSync(target).size<65536&&
            crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')==='af78287b2d8cbd528865fb25ad743c659abc9c4c4bbb85020ee8f50d6a0820da'){
            const {unpackZip}=await import(pathToFileURL(path.join(workspace,'packages/plugin-api/zip.mjs')).href);
            const updated=unpackZip(fs.readFileSync(path.join(workspace,bundle.zip))).find(file=>file.name==='plugin.json');
            if(!updated)throw Error('群聊闭嘴插件清单缺失。');
            const staging=target+'.'+crypto.randomUUID()+'.tmp';
            try{fs.writeFileSync(staging,updated.data,{flag:'wx'});fs.renameSync(staging,target);}
            finally{if(fs.existsSync(staging))fs.unlinkSync(staging);}
          }
        }
        if(id==='voice-studio'&&bundle.version==='1.5.0')await upgradeBundledVoiceStudio(workspace,bundle);
        if(bundledPlugins.has(id)||bundle.defaultEnabled&&defaultPlugins.has(id)||!includesAll&&!firstInstall&&!bundle.defaultEnabled)continue;
        if(fs.existsSync(path.join(workspace,'plugins',id))){bundledPlugins.add(id);if(bundle.defaultEnabled)defaultPlugins.add(id);continue;}
        const preview=installer.inspect({name:id+'.zip',zip:fs.readFileSync(path.join(workspace,bundle.zip)).toString('base64')});
        const installed=installer.install({ticket:preview.ticket,revision:preview.revision});
        bundledPlugins.add(id);
        if(bundle.defaultEnabled){
          updatePlugin(workspace,id,{revision:installed.revision,enabled:true,permissions:[],chats:null,settings:{}});
          defaultPlugins.add(id);
        }
      }
    }finally{installer.dispose();}
  }
  const distributionFile = path.join(workspace, 'config', 'distribution.json');
  if (fs.existsSync(distributionFile)) {
    const previous = JSON.parse(fs.readFileSync(distributionFile, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (config.runtime.python === previous.python) config.runtime.python = python;
    if (dshBundled && config.runtime.dshDesktop === previous.dsh) config.runtime.dshDesktop = dsh;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    if (manifest.buildId && previous.buildId !== manifest.buildId) {
      const pendingFile = path.join(workspace, 'state', 'console-state.json');
      let pending = {}; try { pending = JSON.parse(fs.readFileSync(pendingFile,'utf8')); } catch {}
      fs.writeFileSync(pendingFile,JSON.stringify({...pending,pendingApply:true,dshRestartRequired:true},null,2));
    }
  }
  fs.writeFileSync(distributionFile, JSON.stringify({ version: manifest.version, buildId:manifest.buildId, runtimeRevision:manifest.runtimeRevision, installed: true, dataHome, python, node, dshBundled, dsh, dshHome, externalDshHome, assets: resourcesPath, defaultPlugins:[...defaultPlugins],bundledPlugins:[...bundledPlugins] }, null, 2));
  progress('本机运行环境已准备，正在打开控制台…');
  return { root: workspace, node, python, dataHome, version: manifest.version };
}
module.exports = { bootstrapDeployment };
