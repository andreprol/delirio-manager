'use strict';

// Match por substring, case-insensitive, sem regex (YAGNI — ver spec 2026-10-23).
function findMatch(text, keywords) {
  if (typeof text !== 'string' || !keywords || keywords.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const k of keywords) {
    if (!k || !k.keyword) continue;
    const kw = k.keyword.trim().toLowerCase();
    if (!kw) continue;
    if (haystack.includes(kw)) {
      return { id: k.id, keyword: k.keyword };
    }
  }
  return null;
}

module.exports = { findMatch };
