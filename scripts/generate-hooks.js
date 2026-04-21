const fs=require('fs'),path=require('path');
const args=process.argv.slice(2);
const ga=n=>{const i=args.indexOf('--'+n);return i!==-1?args[i+1]:null;};
const inputDir=ga('input'),configPath=ga('config');
if(!inputDir||!configPath){console.error('Usage: node generate-hooks.js --input <dir> --config <config.json>');process.exit(1);}
const cfg=JSON.parse(fs.readFileSync(configPath,'utf-8'));
const hl=cfg.song.hookLines||[],st=cfg.song.title||'this song',an=cfg.artist.name||'';
function fmt(t){if(!t||t.includes('\n'))return t||'';const w=t.trim().split(/\s+/);if(w.length<=4)return t;const L=[];let c=[];w.forEach((x,i)=>{c.push(x);if(c.length>=4&&i<w.length-1){L.push(c.join(' '));c=[];}});if(c.length)L.push(c.join(' '));return L.join('\n');}
const cta=st+'\nby '+an+'\nlink in bio';
const vA=[hl[0]?fmt(hl[0]):'this song has been\nliving in my head\nfor weeks',hl[1]?fmt(hl[1]):'every single word\nhits different\nwhen you\'ve been there',hl[2]?fmt(hl[2]):'the way this captures\nexactly how it feels\nis insane',hl[3]?fmt(hl[3]):'how did they\nput this into words\nso perfectly',hl[4]?fmt(hl[4]):'okay I\'m actually\nobsessed with\nthis one',cta];
const h0=(hl[0]||'').toLowerCase(),h2=hl[2]||'',h3=hl[3]||'';
const vB=['you know that feeling\nwhen a song puts\nwords to it',h0?'"'+(h0.length>30?h0.substring(0,28)+'...':h0)+'"\n\nwait.':'this came on shuffle\nand I had to\nstop walking',h2?fmt(h2):'the bridge alone\nis worth\neverything',h3?fmt(h3):'I\'ve replayed this\nmore times than\nI can count','not okay.\nnot even close\nto okay.',cta];
const vC=['wait.\nlisten.',hl[0]?hl[0].trim().split(/\s+/).slice(0,3).join(' '):'bad weather.','...','yeah.\nthat one.','you need this\nsong.',cta];
const V={A:{name:'Lyric',d:'Direct lyrics - raw authentic hook',t:vA},B:{name:'Emotion',d:'Relatable reactions - emotional journey',t:vB},C:{name:'Minimal',d:'Ultra-short - curiosity and mystery',t:vC}};
Object.entries(V).forEach(([k,v])=>fs.writeFileSync(path.join(inputDir,'texts-'+k+'.json'),JSON.stringify(v.t,null,2)));
fs.writeFileSync(path.join(inputDir,'hooks-summary.json'),JSON.stringify({generated:new Date().toISOString(),song:st,artist:an,variants:Object.fromEntries(Object.entries(V).map(([k,v])=>[k,{name:v.name,description:v.d,slide1:v.t[0].replace(/\n/g,' / ')}]))},null,2));
console.log('\nHook Generator - '+an+' / '+st+'\n');
Object.entries(V).forEach(([k,v])=>{console.log('Variant '+k+' - '+v.name+': '+v.d);v.t.forEach((t,i)=>console.log('  Slide '+(i+1)+': "'+t.replace(/\n/g,' / ')+'"'));console.log();});
console.log('Saved: texts-A.json, texts-B.json, texts-C.json, hooks-summary.json\n');
