const { createClient } = require('@supabase/supabase-js');

const PROTOCOL = 'https://';
const SUPABASE_DOMAIN = 'autdyccwpbxkgyzwlihg.supabase.co';
const GROQ_DOMAIN = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

const DEFAULT_SUPABASE_URL = PROTOCOL + SUPABASE_DOMAIN;
const GROQ_ENDPOINT = PROTOCOL + GROQ_DOMAIN + GROQ_PATH;

function cleanAndParseJSON(rawText) {
  if (!rawText) throw new Error('Empty response received from LLM model.');

  let cleaned = rawText.trim();

  // 1. Strip complete <think>...</think> reasoning blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Fallback for unclosed <think> tags
  if (cleaned.includes('<think>')) {
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace !== -1) {
      cleaned = cleaned.slice(firstBrace);
    } else {
      cleaned = cleaned.replace(/<think>[\s\S]*/gi, '').trim();
    }
  }

  // 3. Strip markdown code fences (e.g. ```json ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // 4. Locate absolute JSON bounds {...}
  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    cleaned = cleaned.slice(startIdx, endIdx + 1);
  } else {
    throw new Error(`No valid JSON object bounds found in model output. Raw content received: "${rawText.slice(0, 150)}..."`);
  }

  // 5. Clean trailing commas inside arrays or objects
  cleaned = cleaned.replace(/,\s*([\}\]])/g, '$1');

  // 6. Sanitize invalid control characters that break JSON.parse
  cleaned = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse AI JSON response: ${err.message}. Substring attempted: "${cleaned.slice(0, 200)}..."`);
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

    const promptText = `Analyze this medical diagnostic report or lab sheet. Extract key metrics, translate complex terms into plain English, and evaluate anatomical impact across organs, vascular systems, and nervous system tracks.

Return ONLY a valid, properly escaped JSON object matching this structure:
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
  "affected_structures": [
    {
      "id": "heart",
      "status": "attention",
      "info": "Elevated troponin or blood pressure indicating cardiac muscle stress."
    },
    {
      "id": "carotid_arteries",
      "status": "monitor",
      "info": "Potential vascular inflammation secondary to lipid elevations."
    },
    {
      "id": "vagus_nerve",
      "status": "normal",
      "info": "No parasympathetic signal impairment observed."
    }
  ],
  "requires_doctor_flag": true
}

Valid anatomical IDs include:
- Organs: "brain", "heart", "lungs", "liver", "kidneys", "stomach", "spleen"
- Blood Vessels: "aorta", "carotid_arteries", "femoral_arteries", "renal_vasculature", "pulmonary_vessels"
- Nervous System: "spinal_cord", "vagus_nerve", "optic_nerve", "peripheral_nerves"
Statuses must be one of: "normal", "monitor", "attention". Do NOT include internal double-quotes inside string values without escaping them.`;

    const groqResponse = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are an automated medical extraction engine. Output valid JSON only.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: base64Image } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 8192,
        reasoning_format: 'hidden'
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

    return res.status(200).json({ success: true, data: { ...record, affected_structures: parsedData.affected_structures || [] } });

  } catch (error) {
    console.error('Processing error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
