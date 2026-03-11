import { ChromaClient } from 'chromadb';

const host = process.env.CHROMA_HOST || '127.0.0.1';
const port = parseInt(process.env.CHROMA_PORT || '8000', 10);
const collectionName = process.env.CHROMA_COLLECTION || 'school_handbook';

const client = new ChromaClient({ host, port });

async function getCollection() {
  return client.getOrCreateCollection({ name: collectionName });
}

export async function ensureCollection() {
  return getCollection();
}

export async function clearCollection() {
  try {
    await client.deleteCollection({ name: collectionName });
  } catch (err) {
    const isNotFound =
      err?.name === 'ChromaNotFoundError' ||
      err?.message?.includes('does not exist') ||
      err?.message?.includes('could not be found') ||
      err?.status === 404;
    if (isNotFound) return;
    throw err;
  }
}

export async function upsertChunks(chunks, embeddings) {
  const collection = await getCollection();
  await collection.upsert({
    ids: chunks.map((c) => c.id),
    embeddings,
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => c.metadata ?? {}),
  });
}

export async function queryChunks(queryEmbedding, nResults = 4) {
  const collection = await getCollection();
  const result = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults,
    include: ['documents', 'metadatas', 'distances'],
  });
  const docs = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  return docs.map((text, index) => ({
    text: text ?? '',
    metadata: metadatas[index] ?? {},
  }));
}

/** Returns { hasData: boolean, count: number } for ingest status. */
export async function getIngestStatus() {
  try {
    const collection = await getCollection();
    const count = await collection.count();
    return { hasData: count > 0, count };
  } catch (_err) {
    return { hasData: false, count: 0 };
  }
}
