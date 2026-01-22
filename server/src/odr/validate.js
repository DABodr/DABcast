const PI_REGEX = /^(0x)?[0-9a-fA-F]{4}$/;

export function normalizePi(pi) {
  if (!pi) return null;
  const cleaned = String(pi).trim();
  if (!PI_REGEX.test(cleaned)) return null;
  const hex = cleaned.startsWith('0x') || cleaned.startsWith('0X')
    ? cleaned.slice(2)
    : cleaned;
  return `0x${hex.toUpperCase()}`;
}

export function validateService(service, allowedBitrates) {
  const errors = [];
  const normalized = structuredClone(service);
  const piNormalized = normalizePi(service.identity?.pi);
  if (!piNormalized) {
    errors.push('PI invalide (ex: F408 ou 0xF408).');
  } else {
    normalized.identity.pi = piNormalized;
    normalized.identity.serviceIdHex = piNormalized;
  }

  const ps8 = String(service.identity?.ps8 || '');
  const ps16 = String(service.identity?.ps16 || '');
  if (ps8.length > 8) errors.push('PS8 doit contenir au maximum 8 caractères.');
  if (ps16.length > 16) errors.push('PS16 doit contenir au maximum 16 caractères.');

  if (!allowedBitrates.includes(Number(service.dab?.bitrateKbps))) {
    errors.push('Bitrate non autorisé.');
  }

  const port = Number(service.network?.ediOutputTcp?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Port EDI invalide.');
  }

  return { errors, normalized };
}
