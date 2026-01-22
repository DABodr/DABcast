function escapeLabel(value) {
  return String(value ?? '').replace(/"/g, "'");
}

export function buildMuxConfig({ settings, preset }) {
  const e = settings.ensemble;
  const txMode = (settings.dabmux?.txMode || 'EASYDAB').toUpperCase();
  const lines = [];
  lines.push('general {');
  lines.push('    dabmode 1');
  lines.push('    nbframes 0');
  lines.push('    syslog false');
  lines.push('    writescca false');
  lines.push('    tist true');
  if (settings.dabmux.managementPort) {
    lines.push(`    managementport ${settings.dabmux.managementPort}`);
  }
  lines.push('}');
  lines.push('');
  lines.push('remotecontrol {');
  lines.push(`    telnetport ${settings.dabmux.telnetPort}`);
  const zmqEndpoint = settings.dabmux.zmqEndpoint || `tcp://lo:${settings.dabmux.zmqPort || 12722}`;
  lines.push(`    zmqendpoint ${zmqEndpoint}`);
  lines.push('}');
  lines.push('');
  lines.push('ensemble {');
  lines.push(`    id ${e.idHex}`);
  lines.push(`    ecc ${e.eccHex}`);
  lines.push(`    label "${escapeLabel(e.label)}"`);
  lines.push(`    shortlabel "${escapeLabel(e.shortlabel)}"`);
  lines.push(`    international-table ${e.internationalTable}`);
  lines.push(`    local-time-offset ${e.localTimeOffset}`);
  lines.push('}');
  lines.push('');

  lines.push('services {');
  preset.services.forEach((svc, idx) => {
    const key = `srv_${idx + 1}`;
    lines.push(`    ${key} {`);
    lines.push(`        label "${escapeLabel(svc.identity.ps16 || svc.identity.ps8)}"`);
    lines.push(`        id ${svc.identity.serviceIdHex || `0x${svc.identity.pi}`}`);
    lines.push(`        pty ${svc.identity.pty ?? 10}`);
    lines.push(`        language ${svc.identity.languageHex || '0x0F'}`);
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('subchannels {');
  preset.services.forEach((svc, idx) => {
    const key = `sub_${idx + 1}`;
    const input = `tcp://127.0.0.1:${svc.network.ediOutputTcp.port}`;
    lines.push(`    ${key} {`);
    lines.push('        type dabplus');
    lines.push('        inputproto "zmq"');
    lines.push(`        inputuri "${input}"`);
    lines.push(`        zmq-buffer ${svc.input.zmqBuffer ?? 96}`);
    lines.push(`        zmq-prebuffering ${svc.input.zmqPrebuffering ?? 48}`);
    lines.push(`        bitrate ${svc.dab.bitrateKbps}`);
    lines.push(`        id ${idx + 1}`);
    lines.push(`        protection ${svc.dab.protectionLevel ?? 3}`);
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('components {');
  preset.services.forEach((svc, idx) => {
    const comp = `comp_${idx + 1}`;
    const srv = `srv_${idx + 1}`;
    const sub = `sub_${idx + 1}`;
    lines.push(`    ${comp} {`);
    lines.push(`        service ${srv}`);
    lines.push(`        subchannel ${sub}`);
    lines.push('        figtype 0x2');
    if (svc.pad?.sls?.enabled) {
      lines.push('        user-applications {');
      lines.push('            userapp "slideshow"');
      lines.push('        }');
    }
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('outputs {');
  if (txMode === 'USRP1') {
    lines.push('    stdout "fifo:///dev/stdout?type=raw"');
  } else if (txMode === 'EDI') {
    lines.push('    throttle "simul://"');
    lines.push('    edi {');
    lines.push('        destinations {');
    lines.push('            webapp_tcp {');
    lines.push('                protocol tcp');
    lines.push(`                listenport ${settings.dabmux.ediTcpListenPort}`);
    lines.push('            }');
    lines.push('        }');
    lines.push('    }');
  } else {
    const ip = settings.dabmux?.easyDabOutput?.ip || '0.0.0.0';
    const port = Number(settings.dabmux?.easyDabOutput?.port) || 18081;
    lines.push('    throttle "simul://"');
    lines.push(`    zmq "zmq+tcp://${ip}:${port}"`);
  }
  lines.push('}');

  return lines.join('\n') + '\n';
}
