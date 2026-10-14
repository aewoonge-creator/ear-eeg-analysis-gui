const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFile, inspect, makeWelch, bandPowers } = require('../analysis.js');
const settings = { autoRate: true, fs: 256, lowCut: 0, highCut: 0, notch: false, convertUv: false, metadataGain: true, gain: 24, vref: 4.5, segmentLength: 256, previewSeconds: 12 };
function file(text) { return new Blob([text]); }
function signalCsv(count, options = {}) {
  const fs = options.fs || 256;
  const rows = [options.meta || '', 'pc_time_s,t_us,' + Array.from({length:8}, (_, c) => `ch${c+1}`).join(',')];
  for(let i=0; i<count; i++) rows.push([1000+i/fs, i/fs*1e6, ...Array.from({length:8}, (_, c) => (c+1)*Math.sin(2*Math.PI*10*i/fs))].join(','));
  return file(rows.join('\r\n'));
}
function close(a, b, tolerance = 1e-9) { assert.ok(Math.abs(a-b) <= tolerance, `${a} != ${b}`); }
test('actual recorder headers: microseconds, PC clock excluded, metadata priority', async () => {
  const info = await inspect(signalCsv(512, {meta:'# actual_saved_rate_hz=250\n# ads_config_rate_sps=500'}));
  assert.equal(info.fs,250); assert.equal(info.channels.length,8);
  const inferred = await inspect(signalCsv(512)); close(inferred.fs,256);
  const ms = await inspect(file('t_ms,ch1\n'+Array.from({length:16},(_,i)=>`${i*4},${i}`).join('\n'))); close(ms.fs,250);
  const seconds = await inspect(file('t_s,ch1\n'+Array.from({length:16},(_,i)=>`${i/100},${i}`).join('\n'))); close(seconds.fs,100);
});
test('one-sided Welch normalization, 10 Hz peak, independent-channel mean and sum', async () => {
  const r = await analyzeFile(signalCsv(1024), settings);
  assert.equal(r.channels.length,8); close(r.fs,256); assert.equal(r.channels[0].psd.segments,7);
  for (let c=0;c<8;c++) {
    const psd = r.channels[c].psd;
    assert.equal(psd.freqs[psd.values.indexOf(Math.max(...psd.values))],10);
    close(psd.values.reduce((s,x)=>s+x,0)*r.frequencyResolution,(c+1)**2/2);
  }
  r.mean.psd.values.forEach((v,i)=>close(r.sum.psd.values[i],8*v));
  close(r.sum.psd.values[10],r.channels.reduce((s,c)=>s+c.psd.values[10],0));
});
test('Welch matches independent direct DFT, including DC and Nyquist', () => {
  const n=32, fs=128, values=Array.from({length:n},(_,i)=> 7+Math.cos(Math.PI*i)+Math.sin(2*Math.PI*3.4*i/n));
  const w=makeWelch(n,fs); values.forEach(x=>w.push(x)); const actual=w.finish();
  const mean=values.reduce((s,x)=>s+x,0)/n;
  const window=values.map((_,i)=>(1-Math.cos(2*Math.PI*i/n))/2);
  const norm=fs*window.reduce((s,x)=>s+x*x,0);
  for(let k=0;k<=n/2;k++) {
    let re=0,im=0;
    values.forEach((v,i)=>{re+=(v-mean)*window[i]*Math.cos(2*Math.PI*k*i/n);im-=(v-mean)*window[i]*Math.sin(2*Math.PI*k*i/n);});
    close(actual.values[k],(re*re+im*im)/norm*(k===0||k===n/2?1:2));
  }
});
test('short and odd length recordings shrink window and include final samples', async () => {
  const r=await analyzeFile(signalCsv(13),settings);
  assert.equal(r.segmentLength,8); assert.equal(r.channels[0].psd.usedSamples,13); assert.equal(r.channels[0].psd.segments,3);
  await assert.rejects(analyzeFile(signalCsv(7),settings),/최소 8/);
});
test('the tail of long recordings contributes; preview remains bounded', async () => {
  const count=210123;
  const rows=['# fs=256','t_us,ch1'];
  for(let i=0;i<count;i++) rows.push(`${i/256*1e6},${i<count/2?0:Math.sin(2*Math.PI*20*i/256)}`);
  const r=await analyzeFile(file(rows.join('\n')),{...settings,previewSeconds:999999});
  assert.equal(r.channels[0].raw.length,20000);
  assert.equal(r.channels[0].psd.usedSamples,count);
  assert.ok(r.channels[0].psd.values[20]>0.05);
  assert.equal(r.channels[0].psd.segments,Math.ceil((count-256)/128)+1);
});
test('missing cells and sentinel split runs without joining samples or treating blanks as zero', async () => {
  const rows=['# fs=256','t_us,ch1,ch2'];
  for(let i=0;i<41;i++) rows.push(`${i/256*1e6},${i===16?'':i===33?-8388608:Math.sin(i)},`);
  const r=await analyzeFile(file(rows.join('\n')),{...settings,segmentLength:16});
  assert.equal(r.channels[0].invalid,2); assert.equal(r.channels[0].psd.usedSamples,32);
  assert.equal(r.channels[1].psd.segments,0); assert.deepEqual(r.mean.included,['ch1']);
  assert.deepEqual(r.mean.psd.values,r.channels[0].psd.values);
});
test('timestamp jumps split windows; malformed rows do not disappear from duration', async () => {
  const rows=['# fs=256','t_us,ch1'];
  for(let i=0;i<32;i++) rows.push(`${(i+(i>=16?100:0))/256*1e6},${Math.sin(i)}`);
  const r=await analyzeFile(file(rows.join('\n')),{...settings,segmentLength:16});
  assert.equal(r.gaps,1); assert.equal(r.channels[0].psd.segments,2);
  const invalid=await analyzeFile(file(rows.join('\n')+'\n1,2,3'),{...settings,segmentLength:16});
  assert.equal(invalid.rows,33); assert.equal(invalid.channels[0].invalid,1);
});
test('channel gains scale PSD by conversion factor squared and can be overridden', async () => {
  const csv=signalCsv(512,{meta:'# ads_gain=24\n# ads_channel_gains=ch1:12 ch2:24'});
  const r=await analyzeFile(csv,{...settings,convertUv:true});
  close(r.channels[0].psd.values[10],r.channels[1].psd.values[10]);
  const override=await analyzeFile(csv,{...settings,convertUv:true,metadataGain:false});
  close(override.channels[0].psd.values[10]*4,override.channels[1].psd.values[10]);
});
test('band integration clips boundaries instead of double-counting adjacent bins', () => {
  const powers=bandPowers([0,2,4,6,8,10,12,14,20,30,40,50],Array(12).fill(1));
  assert.deepEqual(powers.map(b=>b.power),[3,4,5,17,15]);
  close(powers.reduce((s,b)=>s+b.relative,0),1);
});
test('validation reports invalid filters, settings and files with no usable windows', async () => {
  await assert.rejects(analyzeFile(signalCsv(512),{...settings,highCut:128}),/Nyquist/);
  await assert.rejects(analyzeFile(signalCsv(512),{...settings,convertUv:true,gain:0}),/Gain/);
  await assert.rejects(analyzeFile(signalCsv(512),{...settings,segmentLength:100}),/2의 거듭제곱/);
  await assert.rejects(analyzeFile(file('t_us,ch1\n'+Array.from({length:16},(_,i)=>`${i*4000},`).join('\n')),settings),/연속된 유효/);
});
