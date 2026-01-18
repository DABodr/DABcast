const $ = (sel) => document.querySelector(sel);

const svcTableBody = $('#svcTable tbody');
const dlg = $('#dlgService');
const dlgLogs = $('#dlgLogs');
const dlgMux = $('#dlgMux');

const TAB_ORDER = ['general','audio','metadata','triggers'];
let activeTab = 'general';
let activeLogTab = 'all';

let STATE = null;
let editingId = null;
let LOGS_TEXT = '';

function estimateCu(bitrateKbps, protectionLevel = 3) {
  const br = Number(bitrateKbps) || 0;
  const multMap = { 1: 1.45, 2: 1.25, 3: 1.10, 4: 1.00 };
  const mult = multMap[Number(protectionLevel)] ?? multMap[3];
  return Math.max(0, Math.round(Math.round(br * 0.75) * mult));
}

function updateCuPreview() {
  const bitrate = Number($('#f_bitrate')?.value || 0);
  const protection = Number($('#f_prot')?.value || 3);
  const cu = estimateCu(bitrate, protection);
  const cuEl = $('#f_cu');
  if (cuEl) cuEl.value = String(cu);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function badge(status) {
  const s = (status || 'UNKNOWN').toUpperCase();
  let cls = 'pill';
  if (s.includes('RUN')) cls += ' ok';
  else if (s.includes('WARN')) cls += ' warn';
  else if (s.includes('START')) cls += ' warn';
  else if (s.includes('STOP')) cls += ' off';
  return `<span class="${cls}">${s}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

function render() {
  if (!STATE) return;

  $('#muxName').textContent = STATE.preset.name;
  const tx = (STATE.settings.dabmux?.txMode || 'EASYDAB');
  const out = (tx === 'EASYDAB')
    ? `ZMQ: ${STATE.settings.dabmux.easyDabOutput?.ip || '0.0.0.0'}:${STATE.settings.dabmux.easyDabOutput?.port || 18081}`
    : (tx === 'EDI')
      ? `EDI TCP: ${STATE.settings.dabmux.ediTcpListenPort}`
      : 'USRP1';
  $('#muxSubtitle').textContent = `Preset: ${STATE.preset.id} | TX: ${tx} | ${out}`;

  // capacity hint (CU)
  const cap = STATE.preset.capacity || { totalCu: 0, maxCu: 864 };
  const capEl = $('#capHint');
  if (capEl) {
    const ratio = cap.maxCu ? (cap.totalCu / cap.maxCu) : 0;
    capEl.textContent = `Capacity: ${cap.totalCu}/${cap.maxCu} CU (estim.)`;
    capEl.classList.remove('cap-ok','cap-warn','cap-bad');
    if (ratio < 0.8) capEl.classList.add('cap-ok');
    else if (ratio <= 1.0) capEl.classList.add('cap-warn');
    else capEl.classList.add('cap-bad');
  }

  const on = STATE.muxRunning;
  const onAir = $('#onAir');
  onAir.textContent = on ? 'ON AIR' : 'OFF AIR';
  onAir.classList.toggle('on', on);

  svcTableBody.innerHTML = '';

  const services = [...STATE.preset.services].sort((a,b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));
  for (const svc of services) {
    const tr = document.createElement('tr');
    const status = svc.runtime?.status || 'UNKNOWN';
    const dlsPreview = svc.runtime?.currentDls || svc.metadata?.defaultDls || '';
    const slsPreview = svc.runtime?.currentSlsUrl || svc.metadata?.slsUrl || '';

    tr.innerHTML = `
      <td>${badge(status)}</td>
      <td>
        <div class="ps">${esc(svc.identity.ps8)}</div>
        <div class="muted">${esc(svc.identity.ps16 || '')}</div>
      </td>
      <td>${svc.dab.bitrateKbps} kbps</td>
      <td>${svc.cu ?? ''}</td>
      <td>${esc(String(svc.dab.protectionLevel ?? 3))}</td>
      <td>${esc(svc.audio?.codec || 'HE-AAC v1')}</td>
      <td>${esc(String(svc.audio?.channels ?? 2))}</td>
      <td>${esc(String((svc.audio?.sampleRateHz ?? 48000) / 1000))} kHz</td>
      <td>${svc.network.ediOutputTcp.port}</td>
      <td class="muted">${esc(svc.input.uri || '')}</td>
      <td class="muted">${esc(svc.input.backupUri || '')}</td>
      <td class="muted">${esc(dlsPreview)}</td>
      <td class="muted">${esc(slsPreview)}</td>
      <td class="row-actions">
        <button class="btn btn-mini" data-act="edit" data-id="${svc.id}">Edit</button>
        <button class="btn btn-mini" data-act="del" data-id="${svc.id}">Del</button>
      </td>
    `;

    svcTableBody.appendChild(tr);
  }

  // lock delete while on air
  document.querySelectorAll('[data-act="del"]').forEach((b) => {
    b.disabled = STATE.muxRunning;
  });
}

function fillBitrates(selectEl, allowed, value) {
  selectEl.innerHTML = '';
  for (const br of allowed) {
    const opt = document.createElement('option');
    opt.value = String(br);
    opt.textContent = String(br);
    if (br === value) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function openDialogFor(service) {
  editingId = service?.id || null;
  const locked = STATE.muxRunning;

  $('#dlgTitle').textContent = editingId ? `Edit: ${service?.identity?.ps8}` : 'Add service';
  $('#dlgLockHint').textContent = locked ? 'ON AIR: identité/bitrate/protection verrouillés (comme DabCast)' : '';

  // --- General tab ---
  $('#f_pi').value = service?.identity?.pi || '';
  $('#f_ps8').value = service?.identity?.ps8 || '';
  $('#f_ps16').value = service?.identity?.ps16 || '';
  $('#f_pty').value = service?.identity?.pty ?? 10;

  $('#f_lang').value = service?.identity?.languageHex || '0x0F';

  fillBitrates($('#f_bitrate'), STATE.allowedBitratesKbps || [], service?.dab?.bitrateKbps ?? 96);
  $('#f_prot').value = String(service?.dab?.protectionLevel ?? 3);

  $('#f_sr').value = String(service?.audio?.sampleRateHz ?? 48000);
  $('#f_ch').value = String(service?.audio?.channels ?? 2);
  $('#f_cu').value = String(service?.cu ?? estimateCu($('#f_bitrate').value, $('#f_prot').value));

  $('#f_zbuf').value = service?.input?.zmqBuffer ?? 96;
  $('#f_zpre').value = service?.input?.zmqPrebuffering ?? 48;

  $('#f_encbuf').value = service?.input?.encoderBufferMs ?? 200;
  $('#f_gain').value = service?.audio?.gainDb ?? 0;
  $('#f_codec').value = service?.audio?.codec || 'HE-AAC v1 (SBR)';

  // --- Audio tab ---
  $('#f_src').value = (service?.input?.mode || 'VLC').toUpperCase().includes('GST') ? 'GSTREAMER' : 'VLC';
  $('#f_uri').value = service?.input?.uri || '';
  $('#f_backup').value = service?.input?.backupUri || '';

  $('#f_wd').value = service?.watchdog?.enabled ? '1' : '0';
  $('#f_thresh').value = service?.watchdog?.silenceThresholdSec ?? 10;
  $('#f_warn').value = service?.watchdog?.warningThresholdSec ?? Math.max(1, Math.floor((service?.watchdog?.silenceThresholdSec ?? 10) / 2));
  $('#f_return').value = service?.watchdog?.returnToMainAfterSec ?? 60;
  $('#f_switch').value = service?.watchdog?.switchToBackupOnSilence ? '1' : '0';

  // --- Metadata tab ---
  $('#f_meta_mode').value = service?.metadata?.mode || 'NONE';
  $('#f_meta_interval').value = service?.metadata?.intervalSec ?? 10;
  $('#f_meta_url').value = service?.metadata?.url || '';
  $('#f_meta_artist').value = service?.metadata?.artistKey || 'artist';
  $('#f_meta_title').value = service?.metadata?.titleKey || 'title';
  $('#f_meta_sls').value = service?.metadata?.slsKey || 'cover';
  $('#f_default_dls').value = service?.metadata?.defaultDls || '';
  $('#f_sls_url').value = service?.metadata?.slsUrl || '';
  $('#f_sls_back').value = service?.metadata?.slsBackColor || '';
  $('#f_sls_font').value = service?.metadata?.slsFontColor || '';
  $('#f_dls_allowed').value = service?.metadata?.defaultDlsAllowed ? '1' : '0';
  $('#f_sls_allowed').value = service?.metadata?.defaultSlsAllowed ? '1' : '0';
  $('#f_dls_included').value = service?.metadata?.dlsIncluded ? '1' : '0';

  // SLS preview (logo)
  const img = $('#slsImg');
  const hint = $('#slsHint');
  if (img) {
    if (editingId) {
      const key = (service?.pad?.fifoName || service?.identity?.ps8 || service?.id || '').toString();
      img.src = `/api/mot/${encodeURIComponent(key)}/logo?ts=${Date.now()}`;
      img.style.display = '';
      if (hint) hint.textContent = `data/mot/${key.toUpperCase()}/slide/logo.*`;
      img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (hint) hint.textContent = 'Logo non trouvé (data/mot/<SERVICE>/slide/logo.*)';
      };
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (hint) hint.textContent = '';
    }
  }

  // lock fields
  // lock fields (identity + dab params like DabCast)
  ['f_pi','f_ps8','f_ps16','f_lang','f_pty','f_bitrate','f_prot','f_sr','f_ch','f_zbuf','f_zpre','f_codec'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  // reset tabs
  setActiveTab('general');

  dlg.showModal();
}

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#dlgService .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('#dlgService .tabpanel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.panel !== tab);
  });
  $('#btnPrev').disabled = (TAB_ORDER.indexOf(activeTab) <= 0);
  $('#btnNext').disabled = (TAB_ORDER.indexOf(activeTab) >= TAB_ORDER.length - 1);
}

async function refresh() {
  STATE = await api('/api/state');
  render();
}

async function start() {
  await api('/api/mux/start', { method: 'POST', body: '{}' });
  await refresh();
}

async function stop() {
  await api('/api/mux/stop', { method: 'POST', body: '{}' });
  await refresh();
}

async function showLogs() {
  const text = await api('/api/logs');
  LOGS_TEXT = String(text || '');
  renderLogs();
  dlgLogs.showModal();
}

function logLineScope(line) {
  const match = line.match(/^\[[^\]]+\]\s+\[([^\]]+)\]\s/);
  return match ? match[1] : '';
}

function filterLogsByTab(tab) {
  if (!LOGS_TEXT) return '';
  if (tab === 'all') return LOGS_TEXT;

  const lines = LOGS_TEXT.split('\n');
  if (tab === 'dabmux') {
    return lines.filter((line) => {
      const scope = logLineScope(line);
      return scope === 'mux' || scope.startsWith('mux:odr-dabmux');
    }).join('\n');
  }

  if (tab === 'audio') {
    return lines.filter((line) => {
      const scope = logLineScope(line);
      return scope.includes(':audioenc') || scope.includes(':padenc');
    }).join('\n');
  }

  return LOGS_TEXT;
}

function renderLogs() {
  document.querySelectorAll('.logs-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.logtab === activeLogTab);
  });
  $('#logsPre').textContent = filterLogsByTab(activeLogTab);
}

function openMuxDialog() {
  const locked = STATE.muxRunning;
  $('#muxLockHint').textContent = locked ? 'ON AIR: certains champs sont verrouillés' : '';

  // ensemble
  $('#m_ens_id').value = STATE.settings.ensemble.idHex || '';
  $('#m_ecc').value = STATE.settings.ensemble.eccHex || '';
  $('#m_label').value = STATE.settings.ensemble.label || '';
  $('#m_short').value = STATE.settings.ensemble.shortlabel || '';

  // ports / tx
  $('#m_txmode').value = (STATE.settings.dabmux.txMode || 'EASYDAB');
  $('#m_easydab_ip').value = STATE.settings.dabmux.easyDabOutput?.ip || '0.0.0.0';
  $('#m_easydab_port').value = STATE.settings.dabmux.easyDabOutput?.port || 18081;
  $('#m_edi_port').value = STATE.settings.dabmux.ediTcpListenPort || 13000;
  $('#m_mgmt').value = STATE.settings.dabmux.managementPort || 12720;
  $('#m_telnet').value = STATE.settings.dabmux.telnetPort || 12721;

  // lock key fields when ON AIR (like DabCast)
  ['m_ens_id','m_ecc','m_txmode','m_easydab_ip','m_easydab_port','m_edi_port'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  dlgMux.showModal();
}

async function saveMuxSettings() {
  const patch = {
    ensemble: {
      idHex: $('#m_ens_id').value.trim(),
      eccHex: $('#m_ecc').value.trim(),
      label: $('#m_label').value.trim(),
      shortlabel: $('#m_short').value.trim(),
    },
    dabmux: {
      txMode: $('#m_txmode').value,
      managementPort: Number($('#m_mgmt').value),
      telnetPort: Number($('#m_telnet').value),
      ediTcpListenPort: Number($('#m_edi_port').value),
      easyDabOutput: {
        ip: $('#m_easydab_ip').value.trim(),
        port: Number($('#m_easydab_port').value)
      }
    }
  };
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  await refresh();
}

// events
$('#btnStart').addEventListener('click', start);
$('#btnStop').addEventListener('click', stop);
$('#btnLogs').addEventListener('click', showLogs);
$('#btnMux').addEventListener('click', openMuxDialog);
$('#btnAdd').addEventListener('click', () => openDialogFor(null));

document.querySelectorAll('.logs-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeLogTab = btn.dataset.logtab || 'all';
    renderLogs();
  });
});

['f_bitrate', 'f_prot'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', updateCuPreview);
});

document.querySelectorAll('[data-action="svc-cancel"]').forEach((btn) => {
  btn.addEventListener('click', () => dlg.close());
});
document.querySelectorAll('[data-action="mux-cancel"]').forEach((btn) => {
  btn.addEventListener('click', () => dlgMux.close());
});

// service tabs + wizard buttons
document.querySelectorAll('#dlgService .tab').forEach((b) => {
  b.addEventListener('click', () => setActiveTab(b.dataset.tab));
});

$('#btnPrev').addEventListener('click', () => {
  const i = TAB_ORDER.indexOf(activeTab);
  if (i > 0) setActiveTab(TAB_ORDER[i - 1]);
});
$('#btnNext').addEventListener('click', () => {
  const i = TAB_ORDER.indexOf(activeTab);
  if (i < TAB_ORDER.length - 1) setActiveTab(TAB_ORDER[i + 1]);
});

$('#btnSwap').addEventListener('click', () => {
  const a = $('#f_uri').value;
  const b = $('#f_backup').value;
  $('#f_uri').value = b;
  $('#f_backup').value = a;
});

async function uploadLogo() {
  if (!editingId) return alert('Sauvegarde le service avant d\'uploader un logo.');
  const file = $('#f_logo')?.files?.[0];
  if (!file) return alert('Choisis une image.');

  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('read error'));
    r.readAsDataURL(file);
  });

  const key = (STATE.preset.services.find((s) => s.id === editingId)?.pad?.fifoName ||
    STATE.preset.services.find((s) => s.id === editingId)?.identity?.ps8 || editingId);
  await api(`/api/mot/${encodeURIComponent(String(key))}/logo`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl })
  });

  // refresh preview
  const img = $('#slsImg');
  img.src = `/api/mot/${encodeURIComponent(String(key))}/logo?ts=${Date.now()}`;
}

async function clearLogo() {
  if (!editingId) return;
  const key = (STATE.preset.services.find((s) => s.id === editingId)?.pad?.fifoName ||
    STATE.preset.services.find((s) => s.id === editingId)?.identity?.ps8 || editingId);
  await api(`/api/mot/${encodeURIComponent(String(key))}/logo`, { method: 'DELETE', body: '{}' });
  const img = $('#slsImg');
  img.removeAttribute('src');
  img.style.display = 'none';
}

$('#btnUploadLogo').addEventListener('click', () => uploadLogo().catch((e) => alert(e.message || String(e))));
$('#btnClearLogo').addEventListener('click', () => clearLogo().catch((e) => alert(e.message || String(e))));

async function testDlsUrl() {
  const statusEl = $('#dlsTestStatus');
  if (statusEl) statusEl.textContent = 'Test...';
  const url = $('#f_meta_url').value.trim();
  if (!url) {
    if (statusEl) statusEl.textContent = 'URL manquante';
    return;
  }
  try {
    const res = await api('/api/metadata/test/dls', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    if (statusEl) statusEl.textContent = res?.ok ? 'OK' : 'Échec';
    if (res?.text) alert(res.text);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Erreur';
    alert(err.message || String(err));
  }
}

async function testSlsUrl() {
  const statusEl = $('#slsTestStatus');
  if (statusEl) statusEl.textContent = 'Test...';
  const url = $('#f_sls_url').value.trim();
  if (!url) {
    if (statusEl) statusEl.textContent = 'URL manquante';
    return;
  }
  try {
    const res = await api('/api/metadata/test/sls', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    if (statusEl) statusEl.textContent = res?.ok ? 'OK' : 'Échec';
    if (res?.dataUrl) {
      const img = $('#slsImg');
      if (img) {
        img.src = res.dataUrl;
        img.style.display = '';
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Erreur';
    alert(err.message || String(err));
  }
}

$('#btnTestDls').addEventListener('click', () => testDlsUrl().catch((e) => alert(e.message || String(e))));
$('#btnTestSls').addEventListener('click', () => testSlsUrl().catch((e) => alert(e.message || String(e))));

svcTableBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const svc = STATE.preset.services.find((s) => s.id === id);

  if (act === 'edit') {
    openDialogFor(svc);
  }
  if (act === 'del') {
    if (STATE.muxRunning) return;
    await api(`/api/services/${id}`, { method: 'DELETE' });
    await refresh();
  }
});

$('#svcForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const missing = [];
  if (!$('#f_ps8').value.trim()) missing.push('PS8');
  if (!$('#f_pi').value.trim()) missing.push('PI');
  if (!$('#f_lang').value.trim()) missing.push('Language');
  const piValue = $('#f_pi').value.trim();
  if (piValue && !/^[0-9a-fA-F]{4}$/.test(piValue)) {
    return alert('PI invalide (4 hexadécimaux requis).');
  }
  if (missing.length) {
    return alert(`Champs obligatoires: ${missing.join(', ')}`);
  }

  const payload = {
    identity: {
      pi: $('#f_pi').value.trim() || undefined,
      ps8: $('#f_ps8').value.trim(),
      ps16: $('#f_ps16').value.trim() || null,
      pty: Number($('#f_pty').value || 10),
      languageHex: $('#f_lang').value.trim() || undefined
    },
    dab: {
      bitrateKbps: Number($('#f_bitrate').value),
      protectionLevel: Number($('#f_prot').value || 3)
    },
    input: {
      mode: $('#f_src').value,
      uri: $('#f_uri').value.trim() || null,
      backupUri: $('#f_backup').value.trim() || null
      ,
      encoderBufferMs: Number($('#f_encbuf').value || 200),
      zmqBuffer: Number($('#f_zbuf').value || 96),
      zmqPrebuffering: Number($('#f_zpre').value || 48)
    },
    audio: {
      gainDb: Number($('#f_gain').value || 0),
      sampleRateHz: Number($('#f_sr').value || 48000),
      channels: Number($('#f_ch').value || 2),
      codec: $('#f_codec').value
    },
    watchdog: {
      enabled: $('#f_wd').value === '1',
      silenceThresholdSec: Number($('#f_thresh').value || 10),
      warningThresholdSec: Number($('#f_warn').value || 0),
      switchToBackupOnSilence: $('#f_switch').value === '1',
      returnToMainAfterSec: Number($('#f_return').value || 60)
    },
    metadata: {
      mode: $('#f_meta_mode').value,
      intervalSec: Number($('#f_meta_interval').value || 10),
      url: $('#f_meta_url').value.trim() || null,
      artistKey: $('#f_meta_artist').value.trim() || null,
      titleKey: $('#f_meta_title').value.trim() || null,
      slsKey: $('#f_meta_sls').value.trim() || null,
      defaultDls: $('#f_default_dls').value.trim() || null,
      slsUrl: $('#f_sls_url').value.trim() || null,
      slsBackColor: $('#f_sls_back').value.trim() || null,
      slsFontColor: $('#f_sls_font').value.trim() || null,
      defaultDlsAllowed: $('#f_dls_allowed').value === '1',
      defaultSlsAllowed: $('#f_sls_allowed').value === '1',
      dlsIncluded: $('#f_dls_included').value === '1'
    }
  };

  try {
    if (editingId) {
      await api(`/api/services/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
    }
    dlg.close();
    await refresh();
  } catch (err) {
    alert(err.message || String(err));
  }
});

// periodic refresh for live status
refresh();
setInterval(refresh, 2500);

// mux form
$('#muxForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await saveMuxSettings();
    dlgMux.close();
  } catch (err) {
    alert(err.message || String(err));
  }
});
