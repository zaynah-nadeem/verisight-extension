# Verisight Chrome Extension

Checks images on Instagram and Facebook posts and shows whether they look AI-generated.

## Requirements
The extension sends images to the Verisight backend, which must be running on the same computer
at `http://localhost:8000`. The backend is a separate project (FastAPI, Python).

## Install (Chrome or Edge, desktop only)
1. Click **Code**, then **Download ZIP**, and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder (the one that has `manifest.json`).
4. Start the Verisight backend, then open Instagram or Facebook in the browser.

This is a student project. Results are estimates, not proof.