// api/chat.js — SynIQ Backend
const rateMap = new Map()

function checkRate(ip) {
  const now = Date.now()
  const rec = rateMap.get(ip)
  if (!rec || now - rec.start > 60000) { rateMap.set(ip, { count: 1, start: now }); return true }
  if (rec.count >= 20) return false
  rec.count++; return true
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests' })

  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return res.status(400).json({ error: 'Invalid JSON' }) }
  }

  const { messages, system, mode } = body || {}
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' })
  }

  // Keep only last 6 messages and cap content length to reduce tokens
  const geminiMessages = messages.slice(-6).filter(m => m.role && m.content).map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: String(m.content).slice(0, 800) }]
  }))

  if (geminiMessages.length === 0 || geminiMessages[0].role !== 'user') {
    return res.status(400).json({ error: 'First message must be from user' })
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)

  // Keep system prompt very short to reduce input tokens
  const shortSystem = system
    ? String(system).slice(0, 300)
    : 'You are SynIQ, a school tutor. Max 2 sentences. Simple words. End with one question. Never mention AI or Gemini.'

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: shortSystem }]
        },
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: mode === 'prompts' ? 120 : 250,
          temperature: 0.7
        }
      })
    })

    clearTimeout(timer)

    if (!apiRes.ok) {
      const e = await apiRes.json().catch(() => ({}))
      console.error('Gemini error:', e)
      return res.status(502).json({ error: 'AI service error' })
    }

    const data = await apiRes.json()
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Ask me again!'
    return res.status(200).json({ reply })

  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Took too long — please try again!' })
    }
    console.error('Proxy error:', err)
    return res.status(500).json({ error: 'Server error' })
  }
}
