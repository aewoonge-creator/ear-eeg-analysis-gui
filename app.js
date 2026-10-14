"use strict";
const state = { file: null, result: null, worker: null, view: "psd", electrodeLabels: {}, includedChannels: new Set(), availableChannels: [] };
const els = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), el => [el.id, el]));
const BANDS = [
  { name: "Delta", lo: 1, hi: 4, color: "#0f8b8d" },
  { name: "Theta", lo: 4, hi: 8, color: "#e85d04" },
  { name: "Alpha", lo: 8, hi: 13, color: "#1b998b" },
  { name: "Beta", lo: 13, hi: 30, color: "#3454d1" },
  { name: "Gamma", lo: 30, hi: 45, color: "#7b2cbf" },
];
els.csvFile.addEventListener("change", prepareFile);
els.analyzeBtn.addEventListener("click", analyze);
els.cancelBtn.addEventListener("click", () => {
  state.worker?.terminate(); state.worker = null; setBusy(false);
  setStatus("분석 취소", "설정을 변경하거나 다른 CSV를 선택할 수 있습니다.");
});
els.channelSelect.addEventListener("change", render);
els.exportBtn.addEventListener("click", exportSummary);
els.exportPsdBtn.addEventListener("click", exportPsd);
els.mainBandSelect.addEventListener("change", () => {
  const band = BANDS.find(item => item.name === els.mainBandSelect.value);
  if (band) { els.mainBandLow.value = band.lo; els.mainBandHigh.value = band.hi; }
  render();
});
for (const input of [els.mainBandLow, els.mainBandHigh]) {
  input.addEventListener("change", () => { els.mainBandSelect.value = "Custom"; render(); });
}
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => { state.view = tab.dataset.view; render(); });
}
for (const input of document.querySelectorAll(".panel input, .panel select")) {
  if (["channelSelect", "mainBandSelect", "mainBandLow", "mainBandHigh"].includes(input.id)) continue;
  input.addEventListener("change", () => {
    if (!state.result) return;
    state.result = null; els.exportBtn.disabled = els.exportPsdBtn.disabled = true;
    render(); els.channelPsdGrid.replaceChildren(); renderChannelControls();
    setStatus("설정 변경됨", "분석 실행을 눌러 새 설정으로 전체 기록을 계산해주세요.");
  });
}
function setStatus(title, detail) { els.statusTitle.textContent = title; els.statusDetail.textContent = detail; }
function setBusy(busy) {
  for (const input of document.querySelectorAll(".panel input, .panel select")) input.disabled = busy;
  els.analyzeBtn.disabled = busy; els.cancelBtn.hidden = !busy; els.analysisProgress.hidden = !busy;
}
async function prepareFile() {
  if (!els.csvFile.files[0]) return;
  state.file = els.csvFile.files[0];
  state.result = null;
  state.availableChannels = [];
  state.includedChannels = new Set();
  els.fileName.textContent = state.file.name;
  els.exportBtn.disabled = els.exportPsdBtn.disabled = true;
  els.channelPsdGrid.replaceChildren();
  render();
  try {
    const head = await state.file.slice(0, Math.min(state.file.size, 1024 * 1024)).text();
    const headerLine = head.split(/\r?\n/).map(line => line.trim().replace(/^\uFEFF/, "")).find(line => line && !line.startsWith("#"));
    if (!headerLine) throw new Error("CSV 헤더를 찾지 못했습니다.");
    state.availableChannels = parseCsvRow(headerLine).filter(name => /^(?:ch(?:annel)?[ _-]?|eeg[ _-]?)[1-8]$/i.test(name));
    if (!state.availableChannels.length) throw new Error("Ch1~Ch8 EEG 채널을 찾지 못했습니다.");
    state.includedChannels = new Set(state.availableChannels);
    renderChannelControls();
    setStatus("채널 선택", `${state.file.name} · 평균과 합계에 포함할 채널을 선택한 뒤 분석 실행을 눌러주세요.`);
  } catch (error) {
    els.channelList.replaceChildren();
    els.channelSelectionSummary.textContent = "채널을 확인하지 못했습니다.";
    setStatus("CSV 확인 실패", error.message);
  }
}
function analyze() {
  if (!state.file) { setStatus("CSV 대기 중", "먼저 CSV 파일을 선택해주세요."); return; }
  if (!state.includedChannels.size) { setStatus("채널 선택 필요", "평균과 합계에 포함할 채널을 1개 이상 선택해주세요."); return; }
  state.worker?.terminate(); state.result = null;
  els.exportBtn.disabled = els.exportPsdBtn.disabled = true;
  els.channelPsdGrid.replaceChildren(); render();
  setBusy(true); els.analysisProgress.value = 0;
  setStatus("분석 준비", `${state.file.name} · 전체 파일을 분석합니다.`);
  let worker;
  function fail(message) {
    worker?.terminate(); state.worker = null; setBusy(false);
    setStatus("분석 실패", message);
  }
  try { worker = new Worker("analysis-worker.js"); state.worker = worker; }
  catch (error) { fail(`웹 GUI 링크 또는 로컬 HTTP 서버에서 열어주세요. ${error.message}`); return; }
  worker.onerror = () => fail("분석 작업을 시작하지 못했습니다. GitHub Pages 링크 또는 로컬 HTTP 서버에서 열어주세요.");
  worker.onmessage = ({ data }) => {
    if (state.worker !== worker) return;
    if (data.progress) {
      els.analysisProgress.value = data.progress.percent;
      setStatus(data.progress.phase, `${state.file.name} · ${Math.round(data.progress.percent)}%`);
    } else if (data.error) fail(data.error);
    else if (data.result) {
      state.result = data.result; worker.terminate(); state.worker = null; setBusy(false);
      els.sampleRate.value = Number(data.result.fs.toPrecision(10));
      const returnedNames = new Set(data.result.channels.map(c => c.channelName));
      state.includedChannels = new Set([...state.includedChannels].filter(name => returnedNames.has(name)));
      if (!data.result.channels.some(c => c.psd.segments > 0 && state.includedChannels.has(c.channelName))) {
        state.includedChannels = new Set(data.result.channels.filter(c => c.psd.segments > 0).map(c => c.channelName));
      }
      recomputeAggregates();
      fillChannels(); render(); renderChannelGrid();
      els.exportBtn.disabled = els.exportPsdBtn.disabled = false;
      const r = state.result;
      const exclusions = r.channels.reduce((s, c) => s + c.valid - c.psd.usedSamples + c.invalid + c.artifact, 0);
      const qualityText = r.quality.detectedSamples
        ? r.quality.artifactReject
          ? ` · 품질 이상 ${r.quality.detectedSamples.toLocaleString()}행 감지·${r.quality.excludedSamples.toLocaleString()}행 제외`
          : ` · 품질 이상 ${r.quality.detectedSamples.toLocaleString()}행 감지(제외 안 함)`
        : " · 품질 이상 없음";
      setStatus("전체 기록 분석 완료", `${state.file.name} · 선택 ${r.mean.included.length}/${r.channels.length}채널 · ${r.rows.toLocaleString()}행 · Hz 기준: ${r.rateSource} · 시간 끊김 ${r.gaps}회${qualityText} · PSD 미사용 ${exclusions.toLocaleString()} 채널·샘플`);
    }
  };
  worker.postMessage({ file: state.file, settings: {
    autoRate: els.autoRate.checked, fs: els.sampleRate.value,
    lowCut: els.lowCut.value, highCut: els.highCut.value, notch: els.notchToggle.checked,
    convertUv: els.convertUv.checked, metadataGain: els.metadataGain.checked,
    vref: els.vref.value, gain: els.gain.value,
    artifactReject: els.artifactReject.checked, railThresholdPercent: els.railThresholdPercent.value,
    repeatMinimum: els.repeatMinimum.value,
    segmentLength: els.segmentLength.value, previewSeconds: els.timeWindow.value,
  } });
}
function fillChannels() {
  els.channelSelect.replaceChildren();
  const r = state.result;
  for (const [value, name] of [["mean", r.mean.channelName], ["sum", r.sum.channelName], ...r.channels.map((c, i) => [String(i), channelDisplayName(c.channelName)])]) {
    const option = document.createElement("option"); option.value = value; option.textContent = name;
    if (/^\d+$/.test(value) && !r.channels[Number(value)].psd.segments) option.disabled = true;
    els.channelSelect.appendChild(option);
  }
  renderChannelControls();
  refreshAggregateLabels();
}
function renderChannelControls() {
  els.channelList.replaceChildren();
  const channels = state.result
    ? state.result.channels
    : state.availableChannels.map(channelName => ({ channelName, psd: null }));
  for (const c of channels) {
    const pill = document.createElement("div"); pill.className = "channel-pill";
    const top = document.createElement("div"); top.className = "channel-pill-top";
    const label = document.createElement("div"); label.className = "channel-pill-main";
    const detail = c.psd
      ? `${c.psd.segments}구간 · ${c.psd.usedSamples.toLocaleString()}/${state.result.rows.toLocaleString()}샘플 · 품질 제외 ${c.artifact.toLocaleString()} · Gain ${c.gain}`
      : "분석 전";
    label.innerHTML = `<strong>${escapeHtml(c.channelName)}</strong><span>${detail}</span>`;
    const includeLabel = document.createElement("label"); includeLabel.className = "aggregate-check";
    const include = document.createElement("input"); include.type = "checkbox"; include.checked = state.includedChannels.has(c.channelName);
    include.disabled = Boolean(c.psd && !c.psd.segments);
    const includeText = document.createElement("span"); includeText.textContent = "PSD 집계 포함";
    include.addEventListener("change", () => {
      if (include.checked) state.includedChannels.add(c.channelName);
      else state.includedChannels.delete(c.channelName);
      if (!state.includedChannels.size) {
        state.includedChannels.add(c.channelName); include.checked = true;
        setStatus("채널 선택 필요", "선택 평균과 합계에는 채널이 최소 1개 필요합니다.");
        return;
      }
      if (state.result) {
        recomputeAggregates();
        refreshAggregateLabels();
        render(); renderChannelGrid();
      } else updateChannelSelectionSummary();
    });
    includeLabel.append(include, includeText);
    top.append(label, includeLabel);
    const input = document.createElement("input");
    input.className = "electrode-input";
    input.type = "text";
    input.placeholder = "전극명";
    input.value = state.electrodeLabels[c.channelName] || "";
    input.addEventListener("input", () => {
      state.electrodeLabels[c.channelName] = input.value.trim();
      refreshChannelLabels();
      render();
      if (state.result) renderChannelGrid();
    });
    pill.append(top, input);
    els.channelList.appendChild(pill);
  }
  updateChannelSelectionSummary();
}
function selected() {
  const r = state.result;
  return els.channelSelect.value === "mean" ? r.mean : els.channelSelect.value === "sum" ? r.sum : r.channels[Number(els.channelSelect.value)];
}
function ensureIndividualChannelForSignalView() {
  if (!state.result || !["raw", "filtered", "fft"].includes(state.view) || /^\d+$/.test(els.channelSelect.value)) return;
  const preferred = state.result.channels.findIndex(c => c.psd.segments > 0 && state.includedChannels.has(c.channelName));
  const fallback = state.result.channels.findIndex(c => c.psd.segments > 0);
  const index = preferred >= 0 ? preferred : fallback;
  if (index >= 0) els.channelSelect.value = String(index);
}
function renderPlotChannelPicker() {
  els.plotChannelPicker.replaceChildren();
  els.plotChannelPicker.hidden = !state.result;
  if (!state.result) return;
  const label = document.createElement("span"); label.className = "plot-channel-label"; label.textContent = "채널";
  els.plotChannelPicker.appendChild(label);
  const aggregateView = ["psd", "power"].includes(state.view);
  const choices = [
    ...(aggregateView ? [["mean", "선택 평균"], ["sum", "선택 합계"]] : []),
    ...state.result.channels.map((c, index) => [String(index), channelDisplayName(c.channelName), !c.psd.segments]),
  ];
  for (const [value, name, disabled] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plot-channel-button";
    button.textContent = name;
    button.disabled = Boolean(disabled);
    button.classList.toggle("active", els.channelSelect.value === value);
    button.setAttribute("aria-pressed", String(els.channelSelect.value === value));
    button.addEventListener("click", () => { els.channelSelect.value = value; render(); });
    els.plotChannelPicker.appendChild(button);
  }
}
function channelDisplayName(channelName) {
  const label = state.electrodeLabels[channelName];
  return label ? `${channelName} · ${label}` : channelName;
}
function refreshChannelLabels() {
  if (!state.result) return;
  for (const option of els.channelSelect.options) {
    if (/^\d+$/.test(option.value)) option.textContent = channelDisplayName(state.result.channels[Number(option.value)].channelName);
  }
}
function refreshAggregateLabels() {
  if (!state.result) return;
  updateChannelSelectionSummary();
  for (const option of els.channelSelect.options) {
    if (option.value === "mean") option.textContent = state.result.mean.channelName;
    if (option.value === "sum") option.textContent = state.result.sum.channelName;
  }
}
function updateChannelSelectionSummary() {
  const total = state.result ? state.result.channels.length : state.availableChannels.length;
  els.channelSelectionSummary.textContent = total
    ? `선택 채널 ${state.includedChannels.size}/${total}개 · 이 선택으로 PSD 평균과 합계를 계산합니다.`
    : "분석 전 평균과 합계에 포함할 채널을 선택할 수 있습니다.";
}
function integratePsd(c, lo, hi) {
  if (!c?.psd?.freqs?.length || !c?.psd?.values?.length) return NaN;
  const { freqs, values } = c.psd;
  let area = 0;
  for (let i = 1; i < freqs.length; i++) {
    const f0 = freqs[i - 1], f1 = freqs[i];
    const a = Math.max(lo, f0), b = Math.min(hi, f1);
    if (b <= a) continue;
    const slope = (values[i] - values[i - 1]) / (f1 - f0);
    area += (2 * values[i - 1] + slope * (a + b - 2 * f0)) * (b - a) / 2;
  }
  return area;
}
function decorateAggregate(result) {
  const total = integratePsd(result, 1, 45);
  result.powers = BANDS.map(b => {
    const power = integratePsd(result, b.lo, b.hi);
    return { ...b, power, relative: total > 0 ? power / total : 0 };
  });
  result.alphaPeak = { freq: NaN, value: 0 };
  result.psd.freqs.forEach((freq, i) => {
    if (freq >= 8 && freq <= 13 && result.psd.values[i] > result.alphaPeak.value) result.alphaPeak = { freq, value: result.psd.values[i] };
  });
  return result;
}
function recomputeAggregates() {
  if (!state.result) return;
  const included = state.result.channels.filter(c => c.psd.segments > 0 && state.includedChannels.has(c.channelName));
  if (!included.length) return;
  const createAggregate = mode => {
    const values = included[0].psd.values.map((_, i) => included.reduce((sum, c) => sum + c.psd.values[i], 0) / (mode === "mean" ? included.length : 1));
    const label = mode === "mean" ? "선택 채널 PSD 평균" : "선택 채널 PSD 합계";
    return decorateAggregate({ channelName: `${label} (${included.length}개)`, aggregate: true, included: included.map(c => c.channelName), psd: { ...included[0].psd, values, segments: null, usedSamples: null }, rms: NaN });
  };
  state.result.mean = createAggregate("mean");
  state.result.sum = createAggregate("sum");
}
function selectedLabel(c = selected()) {
  return c.aggregate ? c.channelName : channelDisplayName(c.channelName);
}
function mainBandConfig() {
  const selectedBand = BANDS.find(b => b.name === els.mainBandSelect.value);
  const lo = Number(els.mainBandLow.value), hi = Number(els.mainBandHigh.value);
  const safeLo = Number.isFinite(lo) ? lo : selectedBand?.lo ?? 8;
  const safeHi = Number.isFinite(hi) ? hi : selectedBand?.hi ?? 13;
  return { name: selectedBand ? selectedBand.name : "Custom", lo: Math.min(safeLo, safeHi), hi: Math.max(safeLo, safeHi) };
}
function bandPowerFromPsd(c, lo, hi) {
  return integratePsd(c, lo, hi);
}
function render() {
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === state.view));
  if (!state.result) {
    els.qualityPanel.hidden = true;
    renderPlotChannelPicker();
    clearCanvas(els.mainCanvas, "CSV를 선택하면 전체 기록을 분석합니다.");
    for (const name of ["Duration", "Fs", "Rms", "AlphaPeak", "MainBand"]) els[`metric${name}`].textContent = "-";
    els.mainPlotMeta.textContent = "-"; els.bandTableMeta.textContent = "분석 전"; els.bandTable.replaceChildren();
    return;
  }
  ensureIndividualChannelForSignalView();
  renderPlotChannelPicker();
  const r = state.result, c = selected();
  renderQuality();
  const ref = mainBandConfig();
  const refPower = bandPowerFromPsd(c, ref.lo, ref.hi);
  els.metricDuration.textContent = `${formatNumber(r.duration, 2)} s`;
  els.metricFs.textContent = `${formatNumber(r.fs, 3)} Hz`;
  els.metricRms.textContent = c.aggregate ? "채널 선택 시 표시" : `${formatNumber(c.rms, 2)} ${r.unit}`;
  els.metricAlphaPeak.textContent = `${formatNumber(c.alphaPeak.freq, 2)} Hz`;
  els.metricMainBand.textContent = `${formatNumber(refPower, 3)} ${r.unit}²`;
  const maxHz = Math.min(45, r.fs / 2);
  els.mainPlotMeta.textContent = `${selectedLabel(c)} · ${r.segmentLength} samples/window · Δf ${formatNumber(r.frequencyResolution, 3)} Hz`;
  if (state.view === "psd") {
    els.mainPlotTitle.textContent = "Welch PSD · 전체 기록";
    drawLinePlot(els.mainCanvas, c.psd.freqs, c.psd.values, "Frequency (Hz)", `${r.unit}²/Hz`, "#1b998b", maxHz, true);
  } else if (state.view === "power") {
    els.mainPlotTitle.textContent = "Relative Band Power"; drawBars(els.mainCanvas, c.powers, true);
  } else if (c.aggregate) {
    els.mainPlotTitle.textContent = "채널별 신호";
    clearCanvas(els.mainCanvas, "Raw / Filtered / FFT는 개별 채널을 선택해주세요.");
  } else if (state.view === "fft") {
    els.mainPlotTitle.textContent = "FFT · 첫 연속 구간";
    drawLinePlot(els.mainCanvas, c.fft.freqs, c.fft.amps, "Frequency (Hz)", r.unit, "#3454d1", maxHz);
  } else {
    const values = state.view === "raw" ? c.raw : c.filtered;
    els.mainPlotTitle.textContent = `${state.view === "raw" ? "Raw" : "Filtered"} · 처음 ${formatNumber(values.length / r.fs, 2)}초 미리보기`;
    drawLinePlot(els.mainCanvas, values.map((_, i) => i / r.fs), values, "Time (s)", r.unit, "#0f8b8d");
  }
  els.bandTableMeta.textContent = `${selectedLabel(c)} · 기준 ${ref.name} ${ref.lo}-${ref.hi} Hz · ${r.unit}²`;
  els.bandTable.replaceChildren();
  for (const b of c.powers) {
    const tr = document.createElement("tr");
    const ratio = refPower > 0 ? b.power / refPower : NaN;
    for (const value of [b.name, `${b.lo}-${b.hi}`, formatNumber(b.power, 4), `${formatNumber(b.relative * 100, 2)}%`, `${formatNumber(ratio, 3)}x`]) {
      const td = document.createElement("td"); td.textContent = value; tr.appendChild(td);
    }
    els.bandTable.appendChild(tr);
  }
}
function renderQuality() {
  const r = state.result;
  if (!r?.quality) { els.qualityPanel.hidden = true; els.qualityChannelBreakdown.hidden = true; return; }
  const q = r.quality;
  const hasWarning = q.repeatedSamples > 0 || q.railSamples > 0;
  els.qualityPanel.hidden = false;
  els.qualityPanel.classList.toggle("warning", hasWarning);
  els.qualityStatus.textContent = hasWarning ? "주의" : "양호";
  els.qualityRepeated.textContent = `${q.repeatedSamples.toLocaleString()}샘플 · ${q.repeatedRuns.toLocaleString()}구간`;
  els.qualityRail.textContent = `${q.railSamples.toLocaleString()}샘플`;
  els.qualityExcluded.textContent = `${q.excludedSamples.toLocaleString()}샘플 · ${formatNumber(q.excludedSamples / r.rows * 100, 2)}%`;
  els.qualityMode.textContent = q.artifactReject ? "자동 제외" : "감지만";
  const railChannels = Object.entries(q.railByChannel).filter(([, count]) => count > 0).map(([name, count]) => `${channelDisplayName(name)} ${count}회`);
  const firsts = [q.firstRepeatedRow && `반복 첫 행 ${q.firstRepeatedRow.toLocaleString()}`, q.firstRailRow && `rail 첫 행 ${q.firstRailRow.toLocaleString()}`].filter(Boolean);
  els.qualityDetail.textContent = hasWarning
    ? [`동일 프레임 ${q.repeatMinimum}개 이상 · ADC ${q.railThresholdPercent}% 이상 2개 채널`, ...firsts, railChannels.length ? `rail 채널: ${railChannels.join(", ")}` : ""].filter(Boolean).join(" · ")
    : `동일 프레임 ${q.repeatMinimum}개 이상 및 ADC ${q.railThresholdPercent}% 이상 다채널 포화가 감지되지 않았습니다.`;
  els.qualityChannelList.replaceChildren();
  const excludedChannels = r.channels.filter(c => c.artifact > 0);
  els.qualityChannelBreakdown.hidden = !hasWarning;
  if (!hasWarning) return;
  if (!q.artifactReject) {
    els.qualityChannelSummary.textContent = "감지만 사용 중이므로 제외된 채널은 없습니다.";
    return;
  }
  els.qualityChannelSummary.textContent = `해당 ${q.excludedSamples.toLocaleString()}개 행을 ${excludedChannels.length}개 채널에서 함께 제외해 시간축을 유지합니다.`;
  for (const c of excludedChannels) {
    const railCount = q.railByChannel[c.channelName] || 0;
    const item = document.createElement("div");
    item.className = `quality-channel-item${railCount ? " rail-cause" : ""}`;
    const name = document.createElement("strong"); name.textContent = channelDisplayName(c.channelName);
    const count = document.createElement("span"); count.textContent = `${c.artifact.toLocaleString()}샘플 제외`;
    const reason = document.createElement("em");
    const reasons = [];
    if (q.repeatedSamples) reasons.push("반복 프레임");
    if (railCount) reasons.push(`rail 원인 ${railCount.toLocaleString()}회`);
    else if (q.railSamples) reasons.push("동시 행 제외");
    reason.textContent = reasons.join(" · ");
    item.append(name, count, reason);
    els.qualityChannelList.appendChild(item);
  }
}
function renderChannelGrid() {
  const r = state.result;
  els.channelPsdGrid.replaceChildren();
  els.aggregateNote.textContent = `포함: ${r.mean.included.map(channelDisplayName).join(", ")} · 평균 PSD = 선택 채널 PSD 합계 ÷ ${r.mean.included.length} · 합계 PSD = 선택 채널 PSD를 모두 더한 값`;
  const selectedChannels = r.channels.filter(c => state.includedChannels.has(c.channelName));
  for (const c of [...selectedChannels, r.mean, r.sum]) {
    const card = document.createElement("article"); card.className = "plot-card";
    const title = document.createElement("h3"); title.textContent = selectedLabel(c);
    const info = document.createElement("p"); info.className = "plot-note";
    info.textContent = c.aggregate ? `포함 채널 ${c.included.length}개` : `평균 포함 · ${c.psd.segments}구간 · 사용 ${c.psd.usedSamples.toLocaleString()}샘플 · 품질 제외 ${c.artifact.toLocaleString()}샘플 · 전체 제외 ${(r.rows - c.psd.usedSamples).toLocaleString()}샘플`;
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 430;
    canvas.setAttribute("aria-label", `${c.channelName} Welch PSD`);
    card.append(title, info, canvas); els.channelPsdGrid.appendChild(card);
    if (!c.aggregate && !c.psd.segments) clearCanvas(canvas, "연속 유효 샘플 부족 · 전체 PSD에서 제외");
    else drawLinePlot(canvas, c.psd.freqs, c.psd.values, "Frequency (Hz)", `${r.unit}²/Hz`, "#3454d1", Math.min(45, r.fs / 2), true);
  }
}
function drawLinePlot(canvas, xs, ys, xLabel, yLabel, color, xMax = null, logY = false) {
  const ctx = canvas.getContext("2d"), width = canvas.width, height = canvas.height;
  const frequencyAxis = xLabel === "Frequency (Hz)";
  const pad = { l: 92, r: 26, t: 28, b: 58 };
  let xMin = Infinity, xHi = -Infinity, yMin = Infinity, yMax = -Infinity, count = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(ys[i]) || (logY && ys[i] < 0) || (xMax !== null && xs[i] > xMax)) continue;
    const y = logY ? Math.log10(Math.max(ys[i], 1e-30)) : ys[i];
    xMin = Math.min(xMin, xs[i]); xHi = Math.max(xHi, xs[i]); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); count++;
  }
  if (count < 2) { clearCanvas(canvas, "표시할 데이터가 부족합니다."); return; }
  xHi = xMax ?? xHi;
  if (yMin === yMax) { yMin--; yMax++; }
  const margin = (yMax - yMin) * 0.08; yMin -= margin; yMax += margin;
  drawAxes(ctx, width, height, pad, xLabel, logY ? `log10 ${yLabel}` : yLabel, xMin, xHi, yMin, yMax);
  if (frequencyAxis) drawFrequencyBandGuide(ctx, width, height, pad, xMin, xHi);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  let connected = false;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(ys[i]) || (logY && ys[i] < 0)) { connected = false; continue; }
    if (xs[i] > xHi) break;
    const x = scale(xs[i], xMin, xHi, pad.l, width - pad.r);
    const y = scale(logY ? Math.log10(Math.max(ys[i], 1e-30)) : ys[i], yMin, yMax, height - pad.b, pad.t);
    if (connected) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    connected = true;
  }
  ctx.stroke();
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}
function csvCell(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
function download(rows, suffix) {
  const blob = new Blob(["\uFEFF", rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = `${state.file.name.replace(/\.csv$/i, "")}_${suffix}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function metadataRows() {
  const r = state.result;
  const ref = mainBandConfig();
  return [["# file", state.file.name], ["# sample_rate_hz", r.fs], ["# rate_source", r.rateSource], ["# duration_samples_over_fs_s", r.duration], ["# input_rows", r.rows], ["# segment_samples", r.segmentLength], ["# window", "periodic Hann; segment mean removed"], ["# overlap", "50%; extra end-aligned window for remainder"], ["# low_cut_hz", r.lowCut], ["# high_cut_hz", r.highCut], ["# notch_50_60_hz", r.notch], ["# artifact_rejection", r.quality.artifactReject], ["# repeated_frame_minimum", r.quality.repeatMinimum], ["# repeated_frame_samples", r.quality.repeatedSamples], ["# adc_rail_threshold_percent", r.quality.railThresholdPercent], ["# adc_rail_samples", r.quality.railSamples], ["# quality_detected_samples", r.quality.detectedSamples], ["# quality_excluded_samples", r.quality.excludedSamples], ["# vref_V", r.vref], ["# unit", r.unit], ["# reference_band", ref.name], ["# reference_band_low_hz", ref.lo], ["# reference_band_high_hz", ref.hi], ["# included_channels", r.mean.included.join(" ")], ...r.channels.map(c => [`# ${c.channelName}_electrode`, state.electrodeLabels[c.channelName] || ""]), ...r.channels.map(c => [`# ${c.channelName}_gain`, c.gain])];
}
function exportSummary() {
  if (!state.result) return;
  const r = state.result;
  const ref = mainBandConfig();
  const rows = [...metadataRows(), ["channel", "electrode", "segments", "used_samples", "invalid_samples", "artifact_samples", "excluded_samples", "filtered_rms", "alpha_peak_hz", "reference_power", "band", "power", "relative", "ratio_to_reference"]];
  const selectedChannels = r.channels.filter(c => state.includedChannels.has(c.channelName));
  for (const c of [...selectedChannels, r.mean, r.sum]) {
    const refPower = bandPowerFromPsd(c, ref.lo, ref.hi);
    for (const b of c.powers) rows.push([c.channelName, c.aggregate ? "" : state.electrodeLabels[c.channelName] || "", c.psd.segments ?? "", c.psd.usedSamples, c.invalid ?? "", c.artifact ?? "", c.aggregate ? "" : r.rows - c.psd.usedSamples, Number.isFinite(c.rms) ? c.rms : "", Number.isFinite(c.alphaPeak.freq) ? c.alphaPeak.freq : "", Number.isFinite(refPower) ? refPower : "", b.name, c.aggregate || c.psd.segments ? b.power : "", c.aggregate || c.psd.segments ? b.relative : "", refPower > 0 ? b.power / refPower : ""]);
  }
  download(rows, "eeg_summary");
}
function exportPsd() {
  if (!state.result) return;
  const r = state.result, channels = [...r.channels.filter(c => state.includedChannels.has(c.channelName)), r.mean, r.sum];
  download([...metadataRows(), ["frequency_hz", ...channels.map(c => `${c.channelName}_${r.unit}^2/Hz`)], ...r.mean.psd.freqs.map((f, i) => [f, ...channels.map(c => !c.aggregate && !c.psd.segments ? "" : c.psd.values[i])])], "welch_psd");
}

function drawAxes(ctx, width, height, pad, xLabel, yLabel, xMin, xMax, yMin, yMax) {
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#ccd5df";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#627082";
  ctx.font = "22px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, width / 2, height - 15);
  ctx.save();
  ctx.translate(20, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.font = "18px Segoe UI";
  for (let i = 0; i <= 5; i += 1) {
    const xVal = xMin + (xMax - xMin) * i / 5;
    const x = scale(xVal, xMin, xMax, pad.l, width - pad.r);
    ctx.strokeStyle = "#e7ebf0";
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.stroke();
    ctx.fillText(formatNumber(xVal, 1), x, height - pad.b + 25);
  }
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i += 1) {
    const yVal = yMin + (yMax - yMin) * i / 5;
    const y = scale(yVal, yMin, yMax, height - pad.b, pad.t);
    ctx.strokeStyle = "#e7ebf0";
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "#627082";
    ctx.fillText(formatNumber(yVal, 2), pad.l - 8, y + 6);
  }
  ctx.strokeStyle = "#9aa6b2";
  ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
}

function drawFrequencyBandGuide(ctx, width, height, pad, xMin, xMax) {
  const plotBottom = height - pad.b;
  for (const band of BANDS) {
    const lo = Math.max(band.lo, xMin), hi = Math.min(band.hi, xMax);
    if (hi <= lo) continue;
    const x0 = scale(lo, xMin, xMax, pad.l, width - pad.r);
    const x1 = scale(hi, xMin, xMax, pad.l, width - pad.r);
    ctx.save(); ctx.globalAlpha = 0.055; ctx.fillStyle = band.color;
    ctx.fillRect(x0, pad.t, x1 - x0, plotBottom - pad.t); ctx.restore();
    const center = (x0 + x1) / 2;
    ctx.textAlign = "center";
    ctx.font = "700 15px Segoe UI"; ctx.fillStyle = band.color;
    ctx.fillText(band.name, center, plotBottom - 25);
    ctx.font = "13px Segoe UI"; ctx.fillStyle = "#4b5968";
    ctx.fillText(`${band.lo}-${band.hi} Hz`, center, plotBottom - 8);
  }
}

function parseCsvRow(line) {
  const values = []; let current = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (line[i] === "," && !quoted) { values.push(current.trim()); current = ""; }
    else current += line[i];
  }
  values.push(current.trim());
  return values;
}

function drawBars(canvas, bands, relative) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  const pad = { l: 54, r: 24, t: 28, b: 66 };
  const max = Math.max(...bands.map((b) => relative ? b.relative : b.power), 0.001);
  const gap = 18;
  const barW = (width - pad.l - pad.r - gap * (bands.length - 1)) / bands.length;
  ctx.strokeStyle = "#ccd5df";
  ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
  bands.forEach((band, i) => {
    const value = relative ? band.relative : band.power;
    const h = (height - pad.t - pad.b) * value / max;
    const x = pad.l + i * (barW + gap);
    const y = height - pad.b - h;
    ctx.fillStyle = band.color;
    ctx.fillRect(x, y, barW, h);
    ctx.fillStyle = "#17202a";
    ctx.font = "20px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText(band.name, x + barW / 2, height - 34);
    ctx.fillStyle = "#627082";
    ctx.font = "17px Segoe UI";
    ctx.fillText(relative ? `${formatNumber(value * 100, 1)}%` : formatNumber(value, 2), x + barW / 2, y - 8);
  });
}

function clearCanvas(canvas, message) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#627082";
  ctx.font = "24px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);
}

function scale(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

function formatNumber(value, digits) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 10000 || Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}


render();
