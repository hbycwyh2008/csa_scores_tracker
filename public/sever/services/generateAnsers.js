import OpenAI from 'openai';
import { HANDBOOK_SYSTEM_PROMPT, NOT_FOUND_ANSWER } from '../prompts/systemPrompt.js';

const apiKey = process.env.SG_API_KEY || process.env.OPENAI_API_KEY;
const baseURL = process.env.BASE_URL || 'https://sg.uiuiapi.com/v1';

const client = new OpenAI({
  apiKey,
  baseURL,
});
const chatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

function buildContext(chunks) {
  return chunks
    .map((chunk, index) => {
      const meta = chunk.metadata || {};
      return `Chunk ${index + 1}\nsourceTitle: ${meta.sourceTitle || 'School Handbook'}\nsection: ${meta.section || '—'}\npage: ${meta.page ?? '—'}\ntext:\n${chunk.text}`;
    })
    .join('\n\n');
}

export async function generateAnswer(question, chunks) {
  if (!chunks.length) {
    return { answer: NOT_FOUND_ANSWER, sources: [], found: false };
  }

  const userPrompt = `Question: ${question}\n\nHandbook context:\n${buildContext(chunks)}\n\nReturn strict JSON only.`;

  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: HANDBOOK_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) return { answer: NOT_FOUND_ANSWER, sources: [], found: false };

  try {
    const parsed = JSON.parse(content);
    if (!parsed.found) return { answer: NOT_FOUND_ANSWER, sources: [], found: false };
    return {
      answer: parsed.answer || NOT_FOUND_ANSWER,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      found: Boolean(parsed.found)
    };
  } catch (_err) {
    return { answer: NOT_FOUND_ANSWER, sources: [], found: false };
  }
}
