'use strict';

// Match por substring, case-insensitive, sem regex (YAGNI — ver spec 2026-10-23).
function findMatch(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const k of keywords) {
    if (!k.keyword || !k.keyword.trim()) continue;
    if (haystack.includes(k.keyword.toLowerCase())) {
      return { id: k.id, keyword: k.keyword };
    }
  }
  return null;
}

module.exports = { findMatch };
