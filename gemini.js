/* netlify/functions/gemini.js */

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let userMood;
  try {
    const body = JSON.parse(event.body);
    userMood = body.prompt || body.mood || '';
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const prompt = `You are a sound therapy AI. User mood: "${userMood}". 
Reply with ONLY a JSON object, nothing else:
{"message":"one sentence in English","freq":396,"beat":6}
Choose freq from: 174, 285, 396, 417, 432, 528, 639, 741, 852
Choose beat 4-40 based on mood.`;

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 150,
          responseMimeType: 'application/json',
        },
      }),
    });

    const data = await response.json();
    console.log('Gemini raw:', JSON.stringify(data));

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini text:', text);

    /* Parse et */
    let result;
    try {
      result = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch(e) {
      result = { message: text.substring(0, 100), freq: 432, beat: 7 };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(result),
    };

  } catch(e) {
    console.error('Gemini error:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
