const { createClient } = require('@supabase/supabase-js');

// Base domains and endpoints
const PROTOCOL = 'https://';
const SUPABASE_DOMAIN = 'autdyccwpbxkgyzwlihg.supabase.co';
const GROQ_DOMAIN = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

const DEFAULT_SUPABASE_URL = PROTOCOL + SUPABASE_DOMAIN;
const GROQ_ENDPOINT = PROTOCOL + GROQ_DOMAIN + GROQ_PATH;

function cleanAndParseJSON(rawText) {
  if (!rawText) throw new Error('Empty response received from LLM model.');

  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  const firstMatch = cleaned.match(/\{[\s\S]*\}/);
  if (firstMatch) {
    cleaned = firstMatch[0];
  }

  cleaned = cleaned.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse AI JSON response: ${err.message}. Raw output: "${rawText.slice(0, 100)}..."`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Kx6iR81mnl9OXUmGbfgbOA_PR9Dy2zT';
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const body = req.body || {};
    const base64Image = body.base64Image;
    const fileName = body.fileName;

    if (!base64Image) {
      return res.status(400).json({ error: 'No image payload provided' });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not configured in Vercel environment variables.' });
    }

    const promptText = `Analyze this medical diagnostic report or lab sheet. Extract key metrics and translate complex terms into plain English.

Return strictly a valid JSON object following this exact structure with valid JSON types (no markdown, no preamble):
{
  "summary": "1-2 sentence plain English summary of findings",
  "urgency_rating": 3,
  "jargon_map": {
    "Leukocytosis": "High white blood cell count"
  },
  "vitals": [
    {
      "metric": "WBC",
      "value": 14.2,
      "unit": "10^3/uL",
      "isAnomaly": true
    }
  ],
  "requires_doctor_flag": true
}`;

    const groqResponse = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          {
            role: 'system',
            content: 'You are an automated clinical extraction parser. Output ONLY raw, unformatted valid JSON.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: base64Image } }
            ]
          }
        ],
        temperature: 0.1
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      return res.status(groqResponse.status).json({ error: `Groq API error (${groqResponse.status}): ${errText}` });
    }

    const groqData = await groqResponse.json();
    const rawContent = groqData.choices?.[0]?.message?.content;

    const parsedData = cleanAndParseJSON(rawContent);

    const { data: record, error: dbError } = await supabase
      .from('diagnostic_logs')
      .insert([
        {
          file_name: fileName || 'Diagnostic_Scan.png',
          patient_id: 'P-1042',
          urgency_rating: Number(parsedData.urgency_rating) || 1,
          summary: parsedData.summary || 'Scan processed successfully.',
          jargon_map: parsedData.jargon_map || {},
          vitals: Array.isArray(parsedData.vitals) ? parsedData.vitals : [],
          requires_doctor_flag: Boolean(parsedData.requires_doctor_flag || parsedData.urgency_rating >= 4)
        }
      ])
      .select()
      .single();

    if (dbError) {
      return res.status(500).json({ error: `Supabase Error: ${dbError.message}` });
    }

    return res.status(200).json({ success: true, data: record });

  } catch (error) {
    console.error('Processing error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
