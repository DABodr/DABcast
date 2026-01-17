import express from 'express';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';

import { DEFAULT_SETTINGS } from './defaults.js';
import { ensureDir, readJson, writeJson } from './fsutil.js';
import { FileLogger } from './logger.js';
import { ProcessManager } from './processManager.js';
import { AppState } from './appState.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const rootDir = path.resolve(process.cwd(), '..');
const dataDir = path.resolve(rootDir, 'data');
ensureDir(dataDir);
ensureDir(path.resolve(dataDir, 'presets'));
ensureDir(path.resolve(dataDir, 'logs'));
ensureDir(path.resolve(dataDir, 'runtime'));

// settings.json
const settingsPath = path.resolve(dataDir, 'settings.json');
const settings = readJson(settingsPath, DEFAULT_SETTINGS) || DEFAULT_SETTINGS;
writeJson(settingsPath, settings);

const logger = new FileLogger(path.resolve(dataDir, 'logs', 'dabweb.log'));
const pm = new ProcessManager({ logger, odrBinDir: settings.odrBinDir });

// ensure demo preset exists (shipped)
const shippedDemo = path.resolve(rootDir, 'data', 'presets', 'demo.json');
const demoTarget = path.resolve(dataDir, 'presets', 'demo.json');
if (!fs.existsSync(demoTarget) && fs.existsSync(shippedDemo)) {
  fs.copyFileSync(shippedDemo, demoTarget);
}

const state = new AppState({ settings, dataDir, logger, processManager: pm });

// static web
app.use('/', express.static(path.resolve(rootDir, 'web')));

// API
app.get('/api/state', (req, res) => {
  res.json(state.getState());
});

app.get('/api/presets', (req, res) => {
  res.json({ presets: state.listPresets() });
});

// Global mux/ensemble settings (editable like DabCast)
app.get('/api/settings', (req, res) => {
  res.json({ settings });
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = req.body || {};

    if (patch.ensemble) {
      settings.ensemble = { ...settings.ensemble, ...patch.ensemble };
    }
    if (patch.dabmux) {
      // shallow merge + merge nested easyDabOutput
      settings.dabmux = { ...settings.dabmux, ...patch.dabmux };
      if (patch.dabmux.easyDabOutput) {
        settings.dabmux.easyDabOutput = { ...settings.dabmux.easyDabOutput, ...patch.dabmux.easyDabOutput };
      }
    }

    writeJson(settingsPath, settings);
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/services', (req, res) => {
  try {
    const svc = state.addService(req.body || {});
    res.status(201).json(svc);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch('/api/services/:id', (req, res) => {
  try {
    const svc = state.setService(req.params.id, req.body || {});
    res.json(svc);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.delete('/api/services/:id', (req, res) => {
  try {
    state.deleteService(req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/mux/start', async (req, res) => {
  try {
    await state.startMux();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/mux/stop', async (req, res) => {
  try {
    await state.stopMux();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/logs', (req, res) => {
  const logPath = path.resolve(dataDir, 'logs', 'dabweb.log');
  const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  res.type('text/plain').send(content);
});

// Serve MOT/SLS demo assets for preview (logo, slideshow directory, etc.)
app.get('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const candidates = [
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.jpg'),
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.png'),
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.webp')
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) return res.status(404).end();
    res.sendFile(file);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upload/clear SLS logo (used by the Service window like DabPlatform)
app.post('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dataUrl = String((req.body || {}).dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'dataUrl must be a data:image/* URL' });
    }
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
    const mime = m[1].toLowerCase();
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');
    let ext = 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else if (mime.includes('webp')) ext = 'webp';
    else if (mime.includes('png')) ext = 'png';

    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    ensureDir(dir);
    const out = path.resolve(dir, `logo.${ext}`);
    fs.writeFileSync(out, buf);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    const candidates = [
      path.resolve(dir, 'logo.png'),
      path.resolve(dir, 'logo.jpg'),
      path.resolve(dir, 'logo.webp')
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const listenHost = process.env.HOST || settings.host || '0.0.0.0';
const listenPort = Number(process.env.PORT || settings.port || 8080);
const server = app.listen(listenPort, listenHost, () => {
  logger.line('web', `WebUI on http://${listenHost}:${listenPort}`);
});

server.on('error', (err) => {
  logger.line('web', `listen error: ${String(err?.message || err)}`);
  // Make the error visible to the user in the terminal.
  console.error(err);
  process.exit(1);
});

// Graceful shutdown (stop ODR tools)
async function shutdown() {
  try {
    await state.stopMux();
  } catch (e) {
    logger.line('web', `shutdown error: ${String(e?.message || e)}`);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
