export function findCount(text) {
  const source = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /\b(\d[\d,]*)\s+(?:new\s+|used\s+|certified\s+|pre-owned\s+)?(?:vehicles|cars|results)\b/i,
    /\b(?:showing|found)\s+(?:\d[\d,]*\s*-\s*\d[\d,]*\s+of\s+)?(\d[\d,]*)\b/i,
    /\bof\s+(\d[\d,]*)\s+(?:vehicles|cars|results)\b/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1].replace(/,/g, "");
  }
  return "";
}
