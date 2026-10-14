importScripts("analysis.js");
self.onmessage = async ({ data }) => {
  try {
    const result = await EEGAnalysis.analyzeFile(data.file, data.settings, progress => self.postMessage({ progress }));
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
