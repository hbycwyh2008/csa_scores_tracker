import mammoth from 'mammoth';
import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';

export async function parseHandbook(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return fs.readFile(filePath, 'utf8');
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === '.pdf') {
    const data = await fs.readFile(filePath);
    const result = await pdf(data);
    return result.text;
  }

  throw new Error('Unsupported file type. Use .docx, .txt, .md, or .pdf');
}
