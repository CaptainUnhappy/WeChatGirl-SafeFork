export const DEFAULT_CATEGORIES=Object.freeze([{id:'memory',name:'聊天与记忆'},{id:'media',name:'媒体与表达'},{id:'assistant',name:'助手与自动化'},{id:'tools',name:'连接与工具'},{id:'other',name:'其他插件'}]);
const groups={memory:['people-memory','memory-retrieval','memory-events','memory-evaluation','group-behavior','group-mute','persona-studio','chat-notes','fish-notebook'],media:['voice-studio','cosyvoice-engine','local-voice-model','netease-music','bilibili-public','speech-recognition','video-workbench'],assistant:['admin-dsh','persona-moments']};
export function pluginCategory(id,preferences){const selected=preferences.assignments?.[id];if(preferences.categories.some(c=>c.id===selected))return selected;return Object.entries(groups).find(([,ids])=>ids.includes(id))?.[0]??'tools';}
export function fontSize(value){return Number.isInteger(value)&&value>=12&&value<=22?value:14;}

export const UI_MODES=Object.freeze({
  tech:{label:'科技风',description:'微光网格、浮层、发光状态。'},
  aurora:{label:'星潮特效',description:'流动极光、星尘、霓虹边框和交互高光。'},
  simple:{label:'简洁版',description:'纯色底、平面卡片、低动效。'},
});
export const uiMode=value=>typeof value==='string'&&Object.hasOwn(UI_MODES,value)?value:'tech';
export function nextUiMode(value){
  const modes=Object.keys(UI_MODES);
  return modes[(modes.indexOf(uiMode(value))+1)%modes.length];
}
