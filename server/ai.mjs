// The two AI jobs: turning a person's question into fixed terms, and deciding
// the outcome afterwards. Both are strict: unclear means "no", never a guess.
import { ethers } from 'ethers';

export const CATEGORIES = ['Crypto', 'Sports', 'Music', 'Politics', 'Other'];

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const termsHash = terms => ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(terms)));

function firstJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON in model reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in model reply');
}

const GATE_SYSTEM = `A person wrote a post in their own words that contains a prediction. Their post is shown as written. Your job is to find the prediction in it and fix it into yes/no terms that can be settled later from public sources.
Reply with ONE JSON object and nothing else:
{"ok": boolean, "reason": string, "highlight": string, "terms": {"question": string, "yesMeans": string, "noMeans": string, "source": string, "category": 0|1|2|3|4}}
Rules:
- "highlight" is the one sentence or clause of the post that states the prediction, copied EXACTLY, character for character, from the post. Do not fix spelling, do not add or drop words. Pick the shortest span that carries the whole prediction.
- "question" is your neutral yes/no restatement of that prediction.
- If the post holds more than one prediction, use the main one. If it holds none, set ok=false.
- The question must be answerable YES or NO by a public, checkable fact at the closing time. No opinions, no "will X be good".
- Be specific: name the exact measure, threshold and source (for example a price on a named public data source, an official result, an official announcement). Include the timezone for any time.
- yesMeans and noMeans must be mutually exclusive. If the event does not happen, that is NO.
- Categories: 0 Crypto, 1 Sports, 2 Music, 3 Politics, 4 Other.
- Set ok=false, with a short reason, if it is about a private individual, asks for harm, is unverifiable, is about something that already happened, or cannot be fixed into precise terms.
- Keep each field under 300 characters. Do not mention that you are an AI.`;

const RESOLVE_SYSTEM = `You settle a yes/no prediction call after it closed, using only evidence you can find from reliable public sources.
Reply with ONE JSON object and nothing else:
{"outcome": "YES"|"NO"|"VOID", "reasoning": string, "evidence": [{"title": string, "url": string}]}
Rules:
- Apply the terms exactly as written. YES only if yesMeans is clearly met; NO only if noMeans is clearly met.
- If the evidence is missing, conflicting, or the terms cannot be applied cleanly, answer VOID. Never guess.
- Cite at least one source for YES or NO.`;

export function createAi({ apiKey, model, fetchImpl = fetch }) {
  async function ask(system, user, { search = false } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const body = {
      model, max_tokens: 1500, system,
      messages: [{ role: 'user', content: user }],
    };
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`AI request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  return {
    /** Returns {ok, reason, terms}. Throws only when the model could not be reached. */
    async gate(question, lifeSec, nowIso = new Date().toISOString()) {
      const text = await ask(GATE_SYSTEM, `Now: ${nowIso}\nThe call closes in ${Math.round(lifeSec / 60)} minutes.\nPerson's post:\n${question}`);
      let out;
      try { out = firstJson(text); } catch { return { ok: false, reason: 'Could not turn that into a clear call. Try rephrasing.' }; }
      return validateGate(out);
    },
    /** Returns {outcome: 1|2|3, reasoning, evidence}. Throws when the model could not be reached. */
    async resolve(terms, closesAtIso) {
      const text = await ask(RESOLVE_SYSTEM, `Closed at: ${closesAtIso}\nTerms:\n${JSON.stringify(terms, null, 2)}`, { search: true });
      let out;
      try { out = firstJson(text); } catch { return { outcome: 3, reasoning: 'Unreadable answer', evidence: [] }; }
      return validateResolution(out);
    },
  };
}

export function validateGate(out) {
  if (!out || out.ok !== true) return { ok: false, reason: String(out?.reason ?? 'That cannot be settled as a clear yes/no call.').slice(0, 300) };
  const t = out.terms ?? {};
  const fields = ['question', 'yesMeans', 'noMeans', 'source'];
  for (const f of fields) if (typeof t[f] !== 'string' || t[f].trim().length < 3) return { ok: false, reason: 'The terms were incomplete. Try rephrasing.' };
  const category = Number.isInteger(t.category) && t.category >= 0 && t.category <= 4 ? t.category : 4;
  const terms = Object.fromEntries(fields.map(f => [f, t[f].trim().slice(0, 400)]));
  const highlight = typeof out.highlight === 'string' ? out.highlight : '';
  return { ok: true, reason: '', highlight, terms: { ...terms, category } };
}

export function validateResolution(out) {
  const map = { YES: 1, NO: 2, VOID: 3 };
  const outcome = map[String(out?.outcome).toUpperCase()] ?? 3;
  const evidence = Array.isArray(out?.evidence)
    ? out.evidence.filter(e => e && typeof e.url === 'string').slice(0, 6).map(e => ({ title: String(e.title ?? '').slice(0, 200), url: e.url }))
    : [];
  // A YES or NO with no source behind it is not good enough.
  if (outcome !== 3 && evidence.length === 0) return { outcome: 3, reasoning: 'No source cited', evidence: [] };
  return { outcome, reasoning: String(out?.reasoning ?? '').slice(0, 1000), evidence };
}

/** Tidies a post without changing its words: unix newlines, no trailing spaces, at most one blank line in a row. */
export function cleanPost(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The highlight must be a real piece of the post, or it is dropped. */
export function pickHighlight(post, highlight) {
  const h = String(highlight ?? '').trim();
  if (h.length >= 4 && post.includes(h)) return h;
  return '';
}
