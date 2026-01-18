import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { ensureDir, readJson, writeJson, safeExists } from './fsutil.js';
import { generateMuxConfig } from './muxGenerator.js';
import { ALLOWED_BITRATES_KBPS, DEFAULT_DEMO_PRESET_ID } from './defaults.js';
import { estimateCU, sumCU } from './cu.js';

function nowMs() { return Date.now(); }

async function headOk(url, timeoutMs = 2500) {
  if (!url) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    // some servers don't support HEAD; treat 405 as "maybe ok"
    if (r.status === 405) return true;
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export class AppState {
  constructor({ settings, dataDir, logger, processManager }) {
    this.settings = settings;
    this.dataDir = dataDir;
    this.logger = logger;
    this.pm = processManager;

    this.presetsDir = path.resolve(dataDir, 'presets');
    this.runtimeDir = path.resolve(dataDir, 'runtime');
    this.logFile = path.resolve(dataDir, 'logs', 'dabweb.log');
    ensureDir(this.presetsDir);
    ensureDir(this.runtimeDir);

    this.currentPresetId = DEFAULT_DEMO_PRESET_ID;
    this.preset = this._loadPreset(this.currentPresetId);

    this.muxRunning = false;
    this.watchdogTimer = null;
    this.serviceRuntime = new Map();

    this._initRuntime();
  }

  _loadPreset(id) {
    const p = path.resolve(this.presetsDir, `${id}.json`);
    const preset = readJson(p, null);
    if (!preset) {
      throw new Error(`Preset not found: ${p}`);
    }
    return preset;
  }

  _savePreset() {
    const p = path.resolve(this.presetsDir, `${this.preset.id}.json`);
    writeJson(p, this.preset);
  }

  _initRuntime() {
    for (const svc of this.preset.services) {
      this.serviceRuntime.set(svc.id, {
        status: 'STOPPED',
        activeUri: svc.input.uri,
        lastOkMainMs: 0,
        lastOkBackupMs: 0,
        lastSwitchMs: 0,
        failuresSinceMs: 0
      });
    }
  }

  getState() {
    const services = this.preset.services.map((svc) => {
      const rt = this.serviceRuntime.get(svc.id) || { status: 'UNKNOWN' };
      const cu = estimateCU(svc.dab?.bitrateKbps ?? 0, svc.dab?.protectionLevel ?? 3);
      return {
        ...svc,
        cu,
        runtime: rt
      };
    });

    return {
      muxRunning: this.muxRunning,
      preset: {
        id: this.preset.id,
        name: this.preset.name,
        services,
        capacity: {
          totalCu: services.reduce((a, s) => a + (s.enabled ? (s.cu ?? 0) : 0), 0),
          maxCu: 864
        }
      },
      settings: {
        dabmux: this.settings.dabmux,
        ensemble: this.settings.ensemble
      },
      allowedBitratesKbps: ALLOWED_BITRATES_KBPS
    };
  }

  listPresets() {
    const files = fs.readdirSync(this.presetsDir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const p = readJson(path.resolve(this.presetsDir, f), null);
      return p ? { id: p.id, name: p.name } : null;
    }).filter(Boolean);
  }

  setService(id, patch) {
    const idx = this.preset.services.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Unknown service: ${id}`);

    // lock certain fields while ON AIR (like DabCast)
    const locked = this.muxRunning;
    const existing = this.preset.services[idx];

    const next = structuredClone(existing);

    // always editable
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.input) {
      if (patch.input.mode) next.input.mode = String(patch.input.mode);
      next.input.uri = patch.input.uri ?? next.input.uri;
      next.input.backupUri = patch.input.backupUri ?? next.input.backupUri;
      if (Number.isInteger(patch.input.zmqBuffer)) next.input.zmqBuffer = patch.input.zmqBuffer;
      if (Number.isInteger(patch.input.zmqPrebuffering)) next.input.zmqPrebuffering = patch.input.zmqPrebuffering;
      if (Number.isInteger(patch.input.encoderBufferMs)) next.input.encoderBufferMs = patch.input.encoderBufferMs;
    }
    if (patch.audio) {
      if (typeof patch.audio.gainDb === 'number') next.audio.gainDb = patch.audio.gainDb;
      // kept editable (like DabPlatform) - but you can still lock it later if you want
      if (Number.isInteger(patch.audio.sampleRateHz)) next.audio.sampleRateHz = patch.audio.sampleRateHz;
      if (Number.isInteger(patch.audio.channels)) next.audio.channels = patch.audio.channels;
    }

    if (patch.metadata) {
      next.metadata = { ...(next.metadata || {}), ...(patch.metadata || {}) };
    }
    if (patch.watchdog) {
      if (typeof patch.watchdog.enabled === 'boolean') next.watchdog.enabled = patch.watchdog.enabled;
      if (Number.isInteger(patch.watchdog.silenceThresholdSec)) next.watchdog.silenceThresholdSec = patch.watchdog.silenceThresholdSec;
      if (typeof patch.watchdog.switchToBackupOnSilence === 'boolean') next.watchdog.switchToBackupOnSilence = patch.watchdog.switchToBackupOnSilence;
      if (Number.isInteger(patch.watchdog.returnToMainAfterSec)) next.watchdog.returnToMainAfterSec = patch.watchdog.returnToMainAfterSec;
    }

    // editable only when stopped
    if (!locked) {
      if (patch.identity) {
        if (patch.identity.pi) {
          next.identity.pi = String(patch.identity.pi).toUpperCase().slice(0, 4);
          next.identity.serviceIdHex = `0x${next.identity.pi}`;
        }
        next.identity.ps8 = patch.identity.ps8 ?? next.identity.ps8;
        next.identity.ps16 = patch.identity.ps16 ?? next.identity.ps16;
        next.identity.pty = patch.identity.pty ?? next.identity.pty;
        next.identity.languageHex = patch.identity.languageHex ?? next.identity.languageHex;
      }
      if (patch.dab) {
        if (Number.isInteger(patch.dab.bitrateKbps)) {
          if (!ALLOWED_BITRATES_KBPS.includes(patch.dab.bitrateKbps)) {
            throw new Error(`Bitrate not allowed: ${patch.dab.bitrateKbps}`);
          }
          next.dab.bitrateKbps = patch.dab.bitrateKbps;
        }
        if (Number.isInteger(patch.dab.protectionLevel)) {
          next.dab.protectionLevel = patch.dab.protectionLevel;
        }
      }

      if (patch.audio) {
        if (Number.isInteger(patch.audio.sampleRateHz)) next.audio.sampleRateHz = patch.audio.sampleRateHz;
        if (Number.isInteger(patch.audio.channels)) next.audio.channels = patch.audio.channels;
      }

      if (patch.input) {
        if (typeof patch.input.mode === 'string') next.input.mode = patch.input.mode;
        if (Number.isInteger(patch.input.zmqBuffer)) next.input.zmqBuffer = patch.input.zmqBuffer;
        if (Number.isInteger(patch.input.zmqPrebuffering)) next.input.zmqPrebuffering = patch.input.zmqPrebuffering;
      }

    }

    this.preset.services[idx] = next;
    this._savePreset();
    return next;
  }

  addService(svc) {
    if (this.muxRunning) throw new Error('Cannot add service while ON AIR');

    const id = svc.id || nanoid(8);
    if (this.preset.services.some((s) => s.id === id)) {
      throw new Error('Service id already exists');
    }

    const newSvc = {
      id,
      enabled: true,
      identity: {
        pi: svc.identity?.pi || '0000',
        serviceIdHex: svc.identity?.serviceIdHex || `0x${svc.identity?.pi || '0000'}`,
        ps8: svc.identity?.ps8 || 'RADIO',
        ps16: svc.identity?.ps16 || null,
        languageHex: svc.identity?.languageHex || '0x0F',
        pty: Number.isInteger(svc.identity?.pty) ? svc.identity.pty : 10
      },
      dab: {
        bitrateKbps: ALLOWED_BITRATES_KBPS.includes(svc.dab?.bitrateKbps) ? svc.dab.bitrateKbps : 96,
        protectionLevel: Number.isInteger(svc.dab?.protectionLevel) ? svc.dab.protectionLevel : 3
      },
      input: {
        mode: 'AUDIOENC',
        uri: svc.input?.uri || null,
        backupUri: svc.input?.backupUri || null,
        zmqBuffer: 96,
        zmqPrebuffering: 48,
        encoderBufferMs: Number.isInteger(svc.input?.encoderBufferMs) ? svc.input.encoderBufferMs : 200
      },
      audio: {
        channels: 2,
        sampleRateHz: 48000,
        gainDb: typeof svc.audio?.gainDb === 'number' ? svc.audio.gainDb : 0
      },
      pad: {
        enabled: true,
        fifoName: id.toUpperCase(),
        dlsFile: `${id.toUpperCase()}.dls`,
        slideDir: 'slide',
        motDir: `mot/${id.toUpperCase()}`,
        sls: { enabled: true, logoPath: null }
      },
      network: {
        ediOutputTcp: {
          host: '127.0.0.1',
          port: Number.isInteger(svc.network?.ediOutputTcp?.port) ? svc.network.ediOutputTcp.port : this._pickFreePort()
        }
      },
      watchdog: {
        enabled: true,
        silenceThresholdSec: 10,
        switchToBackupOnSilence: true,
        returnToMainAfterSec: 60
      },
      metadata: {
        mode: 'NONE',
        intervalSec: 10,
        url: null,
        artistKey: 'artist',
        titleKey: 'title',
        slsKey: 'cover',
        defaultDls: '',
        slsBackColor: '',
        slsFontColor: ''
      },
      ui: {
        order: this.preset.services.length + 1
      }
    };

    this.preset.services.push(newSvc);
    this.serviceRuntime.set(newSvc.id, {
      status: 'STOPPED',
      activeUri: newSvc.input.uri,
      lastOkMainMs: 0,
      lastOkBackupMs: 0,
      lastSwitchMs: 0,
      failuresSinceMs: 0
    });
    this._savePreset();
    return newSvc;
  }

  deleteService(id) {
    if (this.muxRunning) throw new Error('Cannot delete service while ON AIR');
    const idx = this.preset.services.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.preset.services.splice(idx, 1);
    this.serviceRuntime.delete(id);
    this._savePreset();
  }

  _pickFreePort() {
    // naive: pick next after max current
    const ports = this.preset.services.map((s) => s.network.ediOutputTcp.port);
    const max = ports.length ? Math.max(...ports) : 9000;
    return max + 1;
  }

  _resolveMotDir(svc) {
    const fifoName = svc.pad?.fifoName || svc.identity?.ps8 || svc.id;
    const motDir = svc.pad?.motDir || `mot/${fifoName}`;
    if (path.isAbsolute(motDir)) return motDir;
    const cleaned = motDir.replace(/^[./]*/, '');
    if (cleaned.startsWith('data/mot/')) {
      return path.resolve(this.dataDir, cleaned.slice('data/'.length));
    }
    if (cleaned.startsWith('mot/')) {
      return path.resolve(this.dataDir, cleaned);
    }
    return path.resolve(this.dataDir, 'mot', cleaned);
  }

  async startMux() {
    if (this.muxRunning) return;

    // Basic capacity check (heuristic CU estimator).
    // Prevent starting clearly invalid mux configs.
    const totalCu = sumCU(this.preset.services);
    if (totalCu > 864) {
      throw new Error(`Capacity exceeded: ${totalCu} CU (max 864). Reduce bitrates/protection or disable services.`);
    }

    // generate mux file
    const muxText = generateMuxConfig({ settings: this.settings, preset: this.preset });
    const muxPath = path.resolve(this.runtimeDir, 'current.mux');
    fs.writeFileSync(muxPath, muxText, 'utf8');
    this.logger.line('mux', `generated mux: ${muxPath}`);

    // start per-service processes
    for (const svc of this.preset.services.filter((s) => s.enabled)) {
      await this._startService(svc);
    }

    // start dabmux
    this.pm.spawn('mux:odr-dabmux', 'odr-dabmux', ['-e', muxPath]);

    this.muxRunning = true;
    this._startWatchdog();
  }

  async stopMux() {
    if (!this.muxRunning) return;

    this._stopWatchdog();

    await this.pm.stop('mux:odr-dabmux');

    // stop services
    for (const svc of this.preset.services) {
      await this._stopService(svc);
    }

    this.muxRunning = false;
  }

  async _startService(svc) {
    const motDirAbs = this._resolveMotDir(svc);
    const fifoPath = path.resolve(motDirAbs, svc.pad.fifoName);

    ensureDir(motDirAbs);

    // create fifo if missing
    if (!safeExists(fifoPath)) {
      // mkfifo is safer than trying to emulate
      this.pm.spawn(`svc:${svc.id}:mkfifo`, 'mkfifo', [fifoPath], { cwd: motDirAbs });
    }

    // padenc
    this.pm.spawn(
      `svc:${svc.id}:padenc`,
      'odr-padenc',
      ['-o', svc.pad.fifoName, '-t', svc.pad.dlsFile, '-d', svc.pad.slideDir],
      { cwd: motDirAbs }
    );

    // audioenc (uses the fifo name in cwd)
    const rt = this.serviceRuntime.get(svc.id);
    if (rt) rt.status = 'STARTING';

    const activeUri = rt?.activeUri || svc.input.uri;
    const args = [
      '-v',
      activeUri,
      '-D',
      '-C',
      String(svc.input.encoderBufferMs ?? 200),
      '-L',
      '--audio-resampler=samplerate',
      '--ps',
      '-c',
      String(svc.audio.channels ?? 2),
      '-p',
      '64',
      '-b',
      String(svc.dab.bitrateKbps),
      '-r',
      String(svc.audio.sampleRateHz ?? 48000),
      '-g',
      String(svc.audio.gainDb ?? 0),
      '-s',
      '60',
      '-o',
      `tcp://localhost:${svc.network.ediOutputTcp.port}`,
      '-P',
      svc.pad.fifoName
    ];

    this.pm.spawn(`svc:${svc.id}:audioenc`, 'odr-audioenc', args, { cwd: motDirAbs });

    if (rt) {
      rt.status = 'RUNNING';
      rt.activeUri = activeUri;
    }
  }

  async _stopService(svc) {
    const rt = this.serviceRuntime.get(svc.id);
    if (rt) rt.status = 'STOPPING';

    await this.pm.stop(`svc:${svc.id}:audioenc`);
    await this.pm.stop(`svc:${svc.id}:padenc`);

    // mkfifo helper exits by itself
    await this.pm.stop(`svc:${svc.id}:mkfifo`);

    if (rt) rt.status = 'STOPPED';
  }

  _startWatchdog() {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(async () => {
      if (!this.muxRunning) return;

      for (const svc of this.preset.services.filter((s) => s.enabled && s.watchdog?.enabled)) {
        const rt = this.serviceRuntime.get(svc.id);
        if (!rt) continue;

        // health check main & backup
        const okMain = await headOk(svc.input.uri);
        const okBackup = await headOk(svc.input.backupUri);

        if (okMain) rt.lastOkMainMs = nowMs();
        if (okBackup) rt.lastOkBackupMs = nowMs();

        const thresholdMs = (svc.watchdog.silenceThresholdSec ?? 10) * 1000;

        // determine if active is failing
        const activeIsMain = rt.activeUri === svc.input.uri;
        const activeOk = activeIsMain ? okMain : okBackup;

        if (activeOk) {
          rt.failuresSinceMs = 0;
          // try returning to main if on backup
          if (!activeIsMain && svc.watchdog.returnToMainAfterSec > 0) {
            const backMs = svc.watchdog.returnToMainAfterSec * 1000;
            if (nowMs() - (rt.lastSwitchMs || 0) >= backMs && okMain) {
              await this._switchServiceUri(svc, svc.input.uri);
            }
          }
          continue;
        }

        // active failed
        if (!rt.failuresSinceMs) rt.failuresSinceMs = nowMs();

        if (nowMs() - rt.failuresSinceMs >= thresholdMs) {
          if (svc.watchdog.switchToBackupOnSilence && svc.input.backupUri) {
            const target = activeIsMain ? svc.input.backupUri : svc.input.uri;
            const targetOk = activeIsMain ? okBackup : okMain;

            if (targetOk) {
              await this._switchServiceUri(svc, target);
              rt.failuresSinceMs = 0;
            }
          }
        }
      }
    }, 5000);

    this.logger.line('watchdog', 'started');
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      this.logger.line('watchdog', 'stopped');
    }
  }

  async _switchServiceUri(svc, newUri) {
    const rt = this.serviceRuntime.get(svc.id);
    if (!rt) return;

    this.logger.line(`svc:${svc.id}`, `switch stream => ${newUri}`);

    // restart audioenc only (padenc can stay)
    await this.pm.stop(`svc:${svc.id}:audioenc`);
    rt.activeUri = newUri;
    rt.lastSwitchMs = nowMs();
    rt.status = 'RESTARTING';

    // start audioenc again
    await this._startService({ ...svc, input: { ...svc.input, uri: newUri } });
  }
}
