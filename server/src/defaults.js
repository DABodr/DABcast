export const ALLOWED_BITRATES_KBPS = [
  8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96,
  104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192
];

export const DEFAULT_SETTINGS = {
  host: "0.0.0.0",
  // Default WebUI port (to avoid common conflicts)
  port: 9090,

  // If ODR tools are not in PATH, set this to e.g. "/usr/local/bin"
  odrBinDir: "",

  // Where we store presets, generated mux files, and logs
  dataDir: "./data",

  // DabMux remote control ports (local)
  dabmux: {
    telnetPort: 12721,
    managementPort: 12720,
    // dabmux remote control over ZMQ (kept like DabCast)
    zmqEndpoint: "tcp://lo:12722",

    // Transmission mode: USRP1 | EDI | EASYDAB (like DabCast)
    txMode: "EASYDAB",

    // EASYDAB output (dabmux ZMQ output endpoint)
    easyDabOutput: {
      ip: "0.0.0.0",
      port: 18081
    },

    // EDI-over-TCP output (only used when txMode === 'EDI')
    ediTcpListenPort: 13000
  },

  // Default ensemble parameters (editable later)
  ensemble: {
    idHex: "0xF408",
    eccHex: "0xE1",
    label: "OpenDigitalRadio",
    shortlabel: "ODR",
    internationalTable: 1,
    localTimeOffset: "auto"
  }
};

export const DEFAULT_DEMO_PRESET_ID = "demo";
