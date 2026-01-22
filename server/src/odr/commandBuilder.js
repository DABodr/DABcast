function isHttpStream(uri) {
  return /^https?:\/\//i.test(uri || '');
}

export function buildPadEncCommand(svc) {
  return {
    bin: 'odr-padenc',
    args: ['-o', svc.pad.fifoName, '-t', svc.pad.dlsFile, '-d', svc.pad.slideDir]
  };
}

export function buildAudioEncCommand({ svc, activeUri, mtaPath }) {
  const sourceFlag = isHttpStream(activeUri) || svc.input?.mode?.toUpperCase().includes('GST') ? '-G' : '-v';
  const codecArgs = svc.audio?.codecArgs || [];
  return {
    bin: 'odr-audioenc',
    args: [
      sourceFlag,
      activeUri,
      '-D',
      '-C',
      String(svc.input.encoderBufferMs ?? 200),
      '-L',
      '--audio-resampler=samplerate',
      ...codecArgs,
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
      '-w',
      mtaPath,
      '-P',
      svc.pad.fifoName
    ]
  };
}

export function buildDabMuxCommand(muxPath) {
  return { bin: 'odr-dabmux', args: ['-e', muxPath] };
}
