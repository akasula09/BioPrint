import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://kx6ir81mnlo9oxumgbfg.supabase.co',
  'sb_publishable_Kx6iR81mnl9OXUmGbfgbOA_PR9Dy2zT'
);

export default async function handler(req, res) {
  // CORS Headers
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
    const { base64Image, fileName } = req.body;

    if (!base64Image) {
      return res.status(400).json({ error: 'No image payload provided' });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not configured in Vercel environment variables.' });
    }

    // Call Groq Vision API via server-side key
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this medical diagnostic report or lab sheet. Extract key metrics and translate complex terms into plain English. 
Return ONLY a valid JSON object matching this schema EXACTLY:
{
  "summary": "<1-2 sentence plain-English summary of findings>",
  "urgency_rating": <number 1-5 where 5 is critical/severe>,
  "jargon_map": {
    "<medical term>": "<plain-English definition>"
  },
  "vitals": [
    { "metric": "<Metric Name>", "value": <numeric value>, "unit": "<unit>", "isAnomaly": <boolean> }
  ],
  "requires_doctor_flag": <boolean, true if urgency_rating >= 4 or critical anomaly exists>
}`
              },
              {
                type: 'image_url',
                image_url: { url: base64Image }
              }
            ]
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      throw new Error(`Groq API error (${groqResponse.status}): ${errText}`);
    }

    const groqData = await groqResponse.json();
    const rawContent = groqData.choices?.[0]?.message?.content;
    const parsedData = JSON.parse(rawContent);

    // Persist parsed record into Supabase
    const { data: record, error: dbError } = await supabase
      .from('diagnostic_logs')
      .insert([
        {
          file_name: fileName || 'Diagnostic_Scan.png',
          patient_id: 'P-1042',
          urgency_rating: parsedData.urgency_rating || 1,
          summary: parsedData.summary || 'Scan processed successfully.',
          jargon_map: parsedData.jargon_map || {},
          vitals: parsedData.vitals || [],
          requires_doctor_flag: Boolean(parsedData.requires_doctor_flag)
        }
      ])
      .select()
      .single();

    if (dbError) throw dbError;

    return res.status(200).json({ success: true, data: record });

  } catch (error) {
    console.error('Processing error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
