const INGEST_STORAGE_KEY = 'handbook_ingest_record';

const form = document.getElementById('ask-form');
const questionInput = document.getElementById('question');
const statusEl = document.getElementById('status');
const answerEl = document.getElementById('answer');
const sourcesEl = document.getElementById('sources');

const ingestForm = document.getElementById('ingest-form');
const ingestStatusEl = document.getElementById('ingest-status');
const handbookFileInput = document.getElementById('handbook-file');
const fileSelectButton = document.getElementById('file-select-button');
const fileSelectedText = document.getElementById('file-selected-text');
const ingestProgress = document.getElementById('ingest-progress');
const ingestProgressBar = document.getElementById('ingest-progress-bar');
const ingestRecordEl = document.getElementById('ingest-record');

function renderSources(sources) {
  sourcesEl.innerHTML = '';
  if (!sources?.length) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = 'No sources available.';
    sourcesEl.appendChild(item);
    return;
  }

  for (const src of sources) {
    const item = document.createElement('li');
    item.innerHTML = `
      <strong>${src.sourceTitle || 'School Handbook'}</strong><br>
      <span>Section: ${src.section || 'N/A'} | Page: ${src.page ?? 'N/A'}</span>
      <p>“${src.quote || ''}”</p>
    `;
    sourcesEl.appendChild(item);
  }
}

if (fileSelectButton && handbookFileInput && fileSelectedText) {
  fileSelectButton.addEventListener('click', () => {
    handbookFileInput.click();
  });

  handbookFileInput.addEventListener('change', () => {
    const file = handbookFileInput.files[0];
    fileSelectedText.textContent = file ? file.name : 'No file chosen';
  });
}

ingestForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const file = handbookFileInput.files[0];
  if (!file) {
    ingestStatusEl.textContent = 'Please choose a file.';
    return;
  }

  ingestStatusEl.textContent = 'Uploading and indexing handbook...';

  if (ingestProgress && ingestProgressBar) {
    ingestProgress.classList.add('progress-active');
    ingestProgressBar.style.width = '10%';
  }

  let fakeProgress = 10;
  let timer;
  if (ingestProgressBar) {
    timer = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + 10, 90);
      ingestProgressBar.style.width = `${fakeProgress}%`;
    }, 300);
  }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/ingest', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json().catch(() => ({}));

    if (timer) clearInterval(timer);
    if (ingestProgressBar) {
      ingestProgressBar.style.width = '100%';
    }

    if (response.ok && data.success) {
      const record = {
        filename: file.name,
        sourceTitle: data.sourceTitle || file.name,
        chunksStored: data.chunksStored,
        ingestedAt: Date.now(),
      };
      try {
        localStorage.setItem(INGEST_STORAGE_KEY, JSON.stringify(record));
      } catch (_e) {}
      ingestStatusEl.textContent = `Ingested handbook successfully. Chunks stored: ${data.chunksStored}.`;
      updateIngestRecordUI(record, true);
    } else {
      ingestStatusEl.textContent = `Ingest failed: ${data.message || 'Unknown error'}`;
    }
  } catch (error) {
    if (timer) clearInterval(timer);
    const message = (error && error.message) || '';
    if (message.includes('fetch')) {
      ingestStatusEl.textContent = 'Cannot reach backend. Open app via http://localhost:3000 and keep node server/app.js running.';
    } else {
      ingestStatusEl.textContent = `Ingest error: ${message || 'Unknown error'}`;
    }
  } finally {
    setTimeout(() => {
      if (ingestProgress) {
        ingestProgress.classList.remove('progress-active');
      }
      if (ingestProgressBar) {
        ingestProgressBar.style.width = '0%';
      }
    }, 800);
  }
});

function updateIngestRecordUI(record, serverHasData) {
  if (!ingestRecordEl) return;
  if (!record) {
    ingestRecordEl.textContent = '';
    ingestRecordEl.className = 'ingest-record';
    return;
  }
  if (!serverHasData) {
    ingestRecordEl.innerHTML = 'Handbook was cleared on the server. Please upload again.';
    ingestRecordEl.className = 'ingest-record ingest-record-warn';
    try {
      localStorage.removeItem(INGEST_STORAGE_KEY);
    } catch (_e) {}
    return;
  }
  const date = record.ingestedAt ? new Date(record.ingestedAt).toLocaleString() : '';
  ingestRecordEl.innerHTML = `Handbook loaded: <strong>${record.filename || record.sourceTitle || 'Handbook'}</strong> (${record.chunksStored ?? 0} chunks)${date ? ` · ${date}` : ''}. You can ask questions below or upload a new file to replace.`;
  ingestRecordEl.className = 'ingest-record ingest-record-ok';
}

async function loadIngestRecord() {
  let record = null;
  try {
    const raw = localStorage.getItem(INGEST_STORAGE_KEY);
    if (raw) record = JSON.parse(raw);
  } catch (_e) {}
  if (!record) {
    updateIngestRecordUI(null);
    return;
  }
  try {
    const res = await fetch('/api/ingest/status');
    const data = await res.json().catch(() => ({}));
    updateIngestRecordUI(record, data.hasData === true);
  } catch (_e) {
    updateIngestRecordUI(record, false);
  }
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadIngestRecord);
} else {
  loadIngestRecord();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  statusEl.textContent = 'Loading...';
  answerEl.textContent = '';
  sourcesEl.innerHTML = '';

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });

    const data = await response.json();
    answerEl.textContent = data.answer || 'No answer.';
    renderSources(data.sources || []);

    if (data.found === false) {
      statusEl.textContent = 'Not found in handbook.';
    } else {
      statusEl.textContent = 'Done.';
    }
  } catch (error) {
    statusEl.textContent = 'Error contacting backend.';
    answerEl.textContent = error.message;
  }
});
