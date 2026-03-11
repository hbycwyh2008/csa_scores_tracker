import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { parseHandbook } from '../services/parseDocx.js';
import { chunkText } from '../services/chunkText.js';
import { embedTexts } from '../services/embedChunks.js';
import { clearCollection, upsertChunks, getIngestStatus } from '../services/chromaClient.js';

const router = Router();
const upload = multer({ dest: 'data/handbook/uploads' });

router.get('/status', async (_req, res) => {
  try {
    const { hasData, count } = await getIngestStatus();
    return res.json({ hasData, count });
  } catch (err) {
    return res.json({ hasData: false, count: 0 });
  }
});

router.post('/', upload.single('file'), async (req, res) => {
  let stage = 'validate-input';
  try {
    let filePath = req.body.filePath;
    let sourceTitle = req.body.sourceTitle || 'School Handbook';

    if (req.file?.path) {
      filePath = req.file.path;
      sourceTitle = req.file.originalname || sourceTitle;
    }

    if (!filePath) {
      return res.status(400).json({ success: false, message: 'Provide file upload or filePath.' });
    }

    stage = 'parse-handbook';
    const resolvedPath = path.resolve(filePath);
    const text = await parseHandbook(resolvedPath, sourceTitle);
    stage = 'chunk-text';
    const chunks = chunkText(text, { sourceTitle });

    stage = 'create-embeddings';
    let embeddings;
    try {
      embeddings = await embedTexts(chunks.map((c) => c.text));
    } catch (err) {
      console.error('[ingest] embedding API error', err);
      return res.status(500).json({
        success: false,
        message: `Embedding API error: ${err.message || 'fetch failed'}. Check OPENAI_API_KEY and BASE_URL (and network/proxy).`,
      });
    }

    stage = 'clear-chroma-collection';
    try {
      await clearCollection();
    } catch (err) {
      console.error('[ingest] Chroma clear error', err);
      return res.status(500).json({
        success: false,
        message: `Chroma error: ${err.message || 'fetch failed'}. Is Chroma running on localhost:8000?`,
      });
    }

    stage = 'upsert-chunks';
    try {
      await upsertChunks(chunks, embeddings);
    } catch (err) {
      console.error('[ingest] Chroma upsert error', err);
      return res.status(500).json({
        success: false,
        message: `Chroma upsert error: ${err.message}. Is Chroma running on localhost:8000?`,
      });
    }

    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    return res.json({
      success: true,
      chunksStored: chunks.length,
      sourceTitle: sourceTitle || 'Handbook',
      message: 'Handbook ingested successfully.'
    });
  } catch (error) {
    console.error('[ingest] failed at stage:', stage, error);
    return res.status(500).json({
      success: false,
      message: `${error.message || 'Unknown error'}`,
    });
  }
});

export default router;
