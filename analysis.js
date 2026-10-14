/* Shared by the browser worker and Node's numerical tests. No recording-sized arrays. */
(function (root) {
  "use strict";
  const MIN_SAMPLES = 8;
  const BANDS = [
    { name: "Delta", lo: 1, hi: 4, color: "#0f8b8d" },
    { name: "Theta", lo: 4, hi: 8, color: "#e85d04" },
    { name: "Alpha", lo: 8, hi: 13, color: "#1b998b" },
    { name: "Beta", lo: 13, hi: 30, color: "#3454d1" },
    { name: "Gamma", lo: 30, hi: 45, color: "#7b2cbf" },
  ];
  function parseCsvLine(line) {
    const values = []; let current = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (line[i] === "," && !quoted) { values.push(current); current = ""; }
      else current += line[i];
    }
    values.push(current);
    return values.map(v => v.trim());
  }
  function number(value) { return value?.trim() ? Number(value) : NaN; }
  async function* lines(file, progress = () => {}) {
    const size = 1024 * 1024;
    const decoder = new TextDecoder();
    let pending = "";
    for (let offset = 0; offset < file.size; offset += size) {
      pending += decoder.decode(await file.slice(offset, offset + size).arrayBuffer(), { stream: true });
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) yield line.trim().replace(/^\uFEFF/, "");
      if (pending.length > size) throw new Error("CSV 한 행이 너무 깁니다. 샘플당 한 행인 CSV를 선택해주세요.");
      progress(Math.min(1, (offset + size) / file.size));
    }
    pending += decoder.decode();
    if (pending.trim()) yield pending.trim();
  }
  function timeColumn(headers) {
    for (const key of ["t_us", "time_us", "timestamp_us", "t_ms", "time_ms", "timestamp_ms", "t_s", "time_s", "pc_time_s", "t", "time", "timestamp"]) {
      const index = headers.findIndex(h => h.toLowerCase() === key);
      if (index >= 0) return { index, scale: key.endsWith("_us") ? 1e-6 : key.endsWith("_ms") ? 1e-3 : 1 };
    }
    return null;
  }
  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  async function inspect(file, progress) {
    let headers, clock, last = NaN, rows = 0;
    const meta = {}, deltas = [];
    for await (const line of lines(file, progress)) {
      if (!line) continue;
      if (line.startsWith("#")) {
        const match = line.match(/^#\s*([^=]+)=(.*)$/);
        if (match) meta[match[1].trim().toLowerCase()] = match[2].trim();
        continue;
      }
      const cells = parseCsvLine(line);
      if (!headers) { headers = cells; clock = timeColumn(headers); continue; }
      rows++;
      if (clock && rows <= 5000) {
        const t = number(cells[clock.index]) * clock.scale;
        if (Number.isFinite(t) && Number.isFinite(last) && t > last) deltas.push(t - last);
        last = t;
      }
    }
    if (!headers || rows < MIN_SAMPLES) throw new Error("CSV 헤더와 최소 8개 샘플이 필요합니다.");
    const channels = headers.map((name, index) => ({ name, index }))
      .filter(c => /^(?:ch(?:annel)?[ _-]?|eeg[ _-]?)[1-8]$/i.test(c.name));
    if (!channels.length) throw new Error("Ch1~Ch8 EEG 채널을 찾지 못했습니다. 시간 열은 EEG 채널로 분석하지 않습니다.");
    let fs, rateSource;
    for (const key of ["actual_saved_rate_hz", "fs", "sample_rate", "sample_rate_hz", "sampling_rate_hz"]) {
      if (Number(meta[key]) > 0 && Number.isFinite(Number(meta[key]))) { fs = Number(meta[key]); rateSource = key; break; }
    }
    if (!fs && deltas.length) { fs = 1 / median(deltas); rateSource = headers[clock.index]; }
    return { headers, channels, meta, rows, clock, fs, rateSource };
  }
  function fft(input) {
    const n = input.length, re = Float64Array.from(input), im = new Float64Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j]] = [re[j], re[i]];
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      for (let k = 0; k < half; k++) {
        const angle = -2 * Math.PI * k / size, wr = Math.cos(angle), wi = Math.sin(angle);
        for (let start = 0; start < n; start += size) {
          const a = start + k, b = a + half;
          const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    return { re, im };
  }
  function makeWelch(n, fs) {
    const window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    const norm = fs * window.reduce((s, x) => s + x * x, 0);
    const sums = new Float64Array(n / 2 + 1), buffer = new Float64Array(n);
    let position = 0, since = 0, segments = 0, runSamples = 0, usedSamples = 0;
    function add() {
      let mean = 0;
      for (let i = 0; i < n; i++) mean += buffer[i] / n;
      const { re, im } = fft(Float64Array.from({ length: n }, (_, i) => (buffer[(position + i) % n] - mean) * window[i]));
      for (let k = 0; k < sums.length; k++) sums[k] += (k === 0 || k === n / 2 ? 1 : 2) * (re[k] ** 2 + im[k] ** 2) / norm;
      segments++;
    }
    function endRun() {
      // Include the final samples with a full end-aligned window (no zero padding).
      if (runSamples >= n) {
        if (since) add();
        usedSamples += runSamples;
      }
      position = 0; since = 0; runSamples = 0;
    }
    return {
      push(x) {
        runSamples++;
        buffer[position] = x;
        position = (position + 1) % n;
        if (runSamples >= n) {
          if (runSamples === n || ++since === n / 2) { add(); since = 0; }
        }
      },
      gap: endRun,
      finish() {
        endRun();
        return { freqs: Array.from(sums, (_, k) => k * fs / n), values: Array.from(sums, x => segments ? x / segments : 0), segments, usedSamples, segmentLength: n };
      },
    };
  }
  function makeFilter(fs, low, high, notch) {
    const stages = [];
    function stage(kind, freq, q) {
      const w = 2 * Math.PI * freq / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
      const b = kind === "low" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : kind === "high" ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [1, -2 * c, 1];
      const a0 = 1 + a, a1 = -2 * c / a0, a2 = (1 - a) / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      stages.push({
        push(x) { const y = b[0] / a0 * x + b[1] / a0 * x1 + b[2] / a0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
        reset() { x1 = x2 = y1 = y2 = 0; },
      });
    }
    if (low > 0) stage("high", low, Math.SQRT1_2);
    if (high > 0) stage("low", high, Math.SQRT1_2);
    if (notch) for (const hz of [50, 60]) if (hz < fs / 2) stage("notch", hz, 20);
    return { push(x) { for (const s of stages) x = s.push(x); return x; }, reset() { stages.forEach(s => s.reset()); } };
  }
  function bandPowers(freqs, values) {
    function integrate(lo, hi) {
      let sum = 0;
      for (let i = 1; i < freqs.length; i++) {
        const f0 = freqs[i - 1], f1 = freqs[i], a = Math.max(lo, f0), b = Math.min(hi, f1);
        if (b <= a) continue;
        const slope = (values[i] - values[i - 1]) / (f1 - f0);
        sum += (2 * values[i - 1] + slope * (a + b - 2 * f0)) * (b - a) / 2;
      }
      return sum;
    }
    const total = integrate(1, 45);
    return BANDS.map(b => { const power = integrate(b.lo, b.hi); return { ...b, power, relative: total ? power / total : 0 }; });
  }
  function decorate(result) {
    result.powers = bandPowers(result.psd.freqs, result.psd.values);
    result.alpha = result.powers[2];
    result.alphaPeak = { freq: NaN, value: 0 };
    result.psd.freqs.forEach((f, i) => {
      if (f >= 8 && f <= 13 && result.psd.values[i] > result.alphaPeak.value) result.alphaPeak = { freq: f, value: result.psd.values[i] };
    });
    return result;
  }
  function aggregate(channels, mode) {
    const valid = channels.filter(c => c.psd.segments > 0);
    if (!valid.length) return null;
    const values = valid[0].psd.values.map((_, i) => valid.reduce((s, c) => s + c.psd.values[i], 0) / (mode === "mean" ? valid.length : 1));
    return decorate({ channelName: mode === "mean" ? "전체 채널 PSD 평균" : "전체 채널 PSD 합계", aggregate: true, included: valid.map(c => c.channelName), psd: { ...valid[0].psd, values, segments: null, usedSamples: null }, rms: NaN });
  }
  async function analyzeFile(file, settings, progress = () => {}) {
    const info = await inspect(file, p => progress({ phase: "CSV 확인", percent: p * 25 }));
    const fs = settings.autoRate ? (info.fs || Number(settings.fs)) : Number(settings.fs);
    const low = Number(settings.lowCut), high = Number(settings.highCut);
    if (!(fs > 0 && Number.isFinite(fs))) throw new Error("샘플링 주파수는 양수여야 합니다.");
    if (![low, high].every(Number.isFinite) || low < 0 || high < 0 || low >= fs / 2 || high >= fs / 2 || (low > 0 && high > 0 && low >= high)) throw new Error("필터는 0(끄기) 또는 Nyquist 주파수 미만으로 설정해주세요. Low < High여야 합니다.");
    const requested = Number(settings.segmentLength);
    if (!(requested >= 8 && requested <= 16384 && Number.isInteger(Math.log2(requested)))) throw new Error("Welch 구간은 8~16384 사이의 2의 거듭제곱이어야 합니다.");
    const n = Math.min(requested, 2 ** Math.floor(Math.log2(info.rows)));
    const vref = Number(settings.vref), gain = Number(settings.gain);
    if (settings.convertUv && (!(vref > 0 && Number.isFinite(vref)) || !(gain > 0 && Number.isFinite(gain)))) throw new Error("Vref와 Gain은 양수여야 합니다.");
    const gains = {};
    for (const m of (info.meta.ads_channel_gains || "").matchAll(/(ch[1-8]):([\d.]+)/gi)) gains[m[1].toLowerCase()] = Number(m[2]);
    const previewLimit = Math.min(20000, Math.max(1, Math.ceil((Number(settings.previewSeconds) || 12) * fs)));
    const channels = info.channels.map(c => {
      const g = settings.metadataGain ? (gains[c.name.toLowerCase()] || Number(info.meta.ads_gain) || gain) : gain;
      if (settings.convertUv && !(g > 0 && Number.isFinite(g))) throw new Error("CSV Gain 설정을 확인해주세요.");
      return { ...c, gain: g, factor: settings.convertUv ? vref / g / (2 ** 23 - 1) * 1e6 : 1, welch: makeWelch(n, fs), filter: makeFilter(fs, low, high, settings.notch), raw: [], filtered: [], fftInput: [], valid: 0, invalid: 0, sumSquares: 0 };
    });
    let headerSeen = false, index = 0, previousTime = NaN, gaps = 0;
    for await (const line of lines(file, p => progress({ phase: "전체 기록 Welch PSD 계산", percent: 25 + p * 75 }))) {
      if (!line || line.startsWith("#")) continue;
      if (!headerSeen) { headerSeen = true; continue; }
      const cells = parseCsvLine(line);
      const time = info.clock ? number(cells[info.clock.index]) * info.clock.scale : NaN;
      const timeGap = info.clock && (!Number.isFinite(time) || (Number.isFinite(previousTime) && (time <= previousTime || time - previousTime > 1.5 / fs)));
      if (timeGap) gaps++;
      previousTime = time;
      for (const c of channels) {
        if (timeGap) { c.welch.gap(); c.filter.reset(); if (c.fftInput.length < n) c.fftInput = []; }
        const count = cells.length === info.headers.length ? number(cells[c.index]) : NaN;
        if (!Number.isFinite(count) || count === -8388608) {
          c.invalid++; c.welch.gap(); c.filter.reset(); if (c.fftInput.length < n) c.fftInput = [];
          if (index < previewLimit) { c.raw.push(NaN); c.filtered.push(NaN); }
          continue;
        }
        const raw = count * c.factor, filtered = c.filter.push(raw);
        c.welch.push(filtered); c.valid++; c.sumSquares += filtered * filtered;
        if (c.fftInput.length < n) c.fftInput.push(filtered);
        if (index < previewLimit) { c.raw.push(raw); c.filtered.push(filtered); }
      }
      index++;
    }
    const results = channels.map(c => {
      const psd = c.welch.finish();
      const fftResult = { freqs: [], amps: [] };
      if (c.fftInput.length === n) {
        const { re, im } = fft(c.fftInput.map((x, i) => x * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n))));
        for (let k = 0; k <= n / 2; k++) { fftResult.freqs.push(k * fs / n); fftResult.amps.push((k === 0 || k === n / 2 ? 1 : 2) * Math.hypot(re[k], im[k]) / (n / 2)); }
      }
      return decorate({ channelName: c.name, gain: c.gain, raw: c.raw, filtered: c.filtered, rms: c.valid ? Math.sqrt(c.sumSquares / c.valid) : NaN, valid: c.valid, invalid: c.invalid, psd, fft: fftResult });
    });
    if (!results.some(c => c.psd.segments)) throw new Error(`연속된 유효 샘플 ${n}개가 없습니다. Welch 구간을 줄이거나 CSV의 결측값·시간 간격을 확인해주세요.`);
    return { fs, rateSource: settings.autoRate ? (info.rateSource || "수동 기본값") : "수동", unit: settings.convertUv ? "uV" : "count", duration: info.rows / fs, rows: info.rows, lowCut: low, highCut: high, notch: settings.notch, vref, convertUv: settings.convertUv, segmentLength: n, frequencyResolution: fs / n, gaps, meta: info.meta, channels: results, mean: aggregate(results, "mean"), sum: aggregate(results, "sum") };
  }
  const api = { analyzeFile, inspect, fft, makeWelch, bandPowers, aggregate, parseCsvLine };
  if (typeof module !== "undefined") module.exports = api;
  else root.EEGAnalysis = api;
})(globalThis);
