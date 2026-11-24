import crypto from 'node:crypto';

export const ORIGINAL_MOODS=['bright','gentle','lively'];
const styles={
  bright:{tempo:104,base:60,scale:[0,2,4,5,7,9,11],chords:[0,4,5,3],pattern:[0,2,2,4,4,3,2,1]},
  gentle:{tempo:84,base:57,scale:[0,2,3,5,7,8,10],chords:[0,5,2,6],pattern:[0,1,2,1,3,2,1,0]},
  lively:{tempo:120,base:67,scale:[0,2,4,5,7,9,11],chords:[0,3,4,0],pattern:[0,2,4,2,3,4,2,0]}
};
const invalid=()=>Object.assign(Error('ORIGINAL_SONG_LYRICS_INVALID'),{code:'ORIGINAL_SONG_LYRICS_INVALID'});
const natural=['C','','D','','E','F','','G','','A','','B'];
const abcNote=midi=>{
  const pitch=midi%12,octave=Math.floor(midi/12)-5,letter=natural[pitch];
  return (letter||'^'+natural[pitch-1])+(octave>=1?"'".repeat(octave):','.repeat(-octave));
};
function linesFor(value){
  if(typeof value!=='string'||value.length>240)throw invalid();
  const lines=value.trim().split(/\r?\n/).map(line=>line.replace(/[，。！？、；：,.!?;：\t ]/gu,'')).filter(Boolean);
  if(lines.length<2||lines.length>8||lines.some(line=>!/^\p{Script=Han}{4,8}$/u.test(line)))throw invalid();
  return lines;
}
export function composeOriginal({lyrics,title,mood='bright'}){
  if(typeof title!=='string'||!title.trim()||title.length>60||!/^[\p{L}\p{N} ·《》！？，。—-]+$/u.test(title.trim())||!ORIGINAL_MOODS.includes(mood))throw invalid();
  const lines=linesFor(lyrics),style=styles[mood],bars=[],melody=[];
  const seed=crypto.createHash('sha256').update(lines.join('\n')).digest();
  lines.forEach((line,index)=>{
    const chars=[...line];
    for(let offset=0;offset<chars.length;offset+=4){
      const part=chars.slice(offset,offset+4),last=index===lines.length-1&&offset+4>=chars.length;
      const chord=last?0:style.chords[bars.length%4];
      const tones=part.map((_char,i)=>{
        const variation=seed[(index*5+i+offset)%seed.length]%3===0?1:0;
        const degree=last&&i===part.length-1?0:(chord+style.pattern[offset+i]+variation)%7;
        return style.base+style.scale[degree];
      });
      const beats=tones.map((_note,i)=>i===tones.length-1?5-tones.length:1);
      melody.push(tones.map((note,i)=>abcNote(note)+(beats[i]>1?beats[i]:'')).join(' ')+' |');
      bars.push({tones,beats,chars:part,chord});
    }
  });
  // Keep lyric units separated to match the score note for note.
  const score=['X:1','T:'+title.trim(),'M:4/4','L:1/4','Q:1/4='+style.tempo,'K:C',...melody].join('\n')+'\n';
  return {score,lyrics:bars.flatMap(bar=>bar.chars).join(' '),bars,tempo:style.tempo,base:style.base,scale:style.scale,mood};
}

const tau=2*Math.PI,rate=24000;
const hz=midi=>440*2**((midi-69)/12);
export function mixOriginalBacking(pcm,arrangement,level=0.34,signal){
  const output=Buffer.from(pcm),beatSamples=60*rate/arrangement.tempo;
  const volume=Math.max(0,Math.min(0.6,Number.isFinite(level)?level:0.34));
  if(!volume)return output;
  const tone=(note,t)=>0.78*Math.sin(tau*hz(note)*t)+0.22*Math.sin(2*tau*hz(note)*t);
  for(let i=0;i<output.length/2;i++){
    if(i%8192===0)signal?.throwIfAborted();
    const beat=i/beatSamples,index=Math.floor(beat/4),bar=arrangement.bars[index];
    if(!bar)break;
    const sub=beat%4,t=(beat%1)*60/arrangement.tempo,half=(beat*2%1)*30/arrangement.tempo;
    const degree=bar.chord;
    const note=(n,octave=0)=>arrangement.base+arrangement.scale[n%7]+12*Math.floor(n/7)+octave;
    const ramp=Math.min(1,t*90),plucked=Math.min(1,half*100)*Math.exp(-half*8);
    const bass=0.25*tone(note(degree,-24),t)*Math.exp(-t*4)*ramp*(Math.floor(sub)%2===0?1:0.46);
    const arp=0.20*tone(note(degree+[0,2,4,2,0,2,4,6][Math.floor(sub*2)],-12),half)*plucked;
    const beatAccent=arrangement.mood==='gentle'?0.028:0.09;
    const kick=beatAccent*Math.sin(tau*(51*t+26*t*Math.exp(-t*25)))*Math.exp(-t*23)*ramp;
    const voice=output.readInt16LE(i*2),mixed=voice*(1-volume*0.14)+(bass+arp+kick)*32768*volume;
    output.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(mixed))),i*2);
  }
  return output;
}
