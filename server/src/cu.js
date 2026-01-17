// Very small CU estimator.
// Note: In real DAB planning, CU depends on protection (EEP/UEP) and bitrate.
// Here we use a pragmatic estimator that is good enough for UI guidance and
// to prevent obvious over-allocation. We can refine later with full ETSI tables.

const PROT_MULT = {
  1: 1.45,
  2: 1.25,
  3: 1.10,
  4: 1.00
};

/**
 * Estimate capacity units consumed by a DAB+ audio subchannel.
 *
 * Heuristic:
 *  - base CU ~= bitrate * 0.75 (gives 88kbps -> 66CU)
 *  - apply protection multiplier.
 */
export function estimateCU(bitrateKbps, protectionLevel = 3) {
  const br = Number(bitrateKbps) || 0;
  const base = Math.round(br * 0.75);
  const mult = PROT_MULT[Number(protectionLevel)] ?? PROT_MULT[3];
  return Math.max(0, Math.round(base * mult));
}

export function sumCU(services) {
  let total = 0;
  for (const s of services) {
    if (s && s.enabled) total += estimateCU(s.dab?.bitrateKbps ?? 0, s.dab?.protectionLevel ?? 3);
  }
  return total;
}
