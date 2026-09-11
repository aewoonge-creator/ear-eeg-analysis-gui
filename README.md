# EEG Analysis Lab

CSV-based EEG analysis GUI for ADS1299 / ear-EEG experiments.

## Features

- Load EEG CSV files directly in the browser
- Detect numeric EEG channels from the CSV header
- Estimate or manually set sampling rate
- Optional ADS1299 count-to-uV conversion
- Band-pass filtering and 50/60 Hz notch filtering
- Raw, filtered, FFT, PSD, and relative band-power plots
- Delta, theta, alpha, beta, and gamma power summary
- Export analysis summary as CSV

## CSV Format

Recommended format:

```csv
# fs=250
t_ms,ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8
0,123,-45,67,0,0,0,0,0
4,128,-42,70,0,0,0,0,0
```

Metadata lines beginning with `#` are optional. If `fs`, `sample_rate_hz`, or
`actual_saved_rate_hz` is present, the GUI uses it as the initial sampling rate.

## Run Locally

Open `index.html` in a browser, or serve the folder:

```powershell
python -m http.server 8765
```

Then open `http://127.0.0.1:8765`.
