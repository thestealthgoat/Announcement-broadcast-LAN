// Prepares files in the browser, then uploads them. Photos are downsized for TVs
// (which also applies phone rotation and converts HEIC), and PDFs become one image per page.
const MAX_W = 1920;
const MAX_H = 1080;

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare this image.'))), type, quality);
  });
}

async function prepareImage(file) {
  if (file.type === 'image/gif') return { blob: file, name: file.name };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read this image.'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
    const fits = scale === 1 && (file.type === 'image/jpeg' || file.type === 'image/png');
    if (fits) return { blob: file, name: file.name };
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = file.type === 'image/png';
    const blob = await canvasBlob(canvas, png ? 'image/png' : 'image/jpeg', 0.9);
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg') };
  } catch {
    return { blob: file, name: file.name }; // let the server have the final say
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function send(url, blob, name, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', blob, name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error ?? 'The upload failed.'));
    };
    xhr.onerror = () => reject(new Error('The connection dropped during the upload.'));
    xhr.send(form);
  });
}

async function json(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'The upload failed.');
  return data;
}

async function uploadPdf(file, query, onProgress, onStatus) {
  onStatus('Reading PDF… Keep this page open and on screen until it finishes.');
  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  const item = await json('/api/media/pdf', { name: file.name.replace(/\.pdf$/i, '').slice(0, 120) || 'PDF', pages: doc.numPages });
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onStatus(`Page ${n} of ${doc.numPages}… Keep this page open and on screen.`);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(MAX_W / base.width, MAX_H / base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await canvasBlob(canvas, 'image/jpeg', 0.88);
      page.cleanup();
      await send(`/api/media/${item.id}/pages/${n}`, blob, `page-${n}.jpg`);
      onProgress(n / doc.numPages);
    }
    return await json(`/api/media/${item.id}/finish${query}`);
  } catch (err) {
    await fetch(`/api/media/${item.id}`, { method: 'DELETE' });
    throw err;
  } finally {
    task.destroy();
  }
}

export async function uploadFile(file, { channelId, onProgress, onStatus }) {
  const query = channelId ? `?channelId=${channelId}` : '';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) return uploadPdf(file, query, onProgress, onStatus);
  if (file.type.startsWith('image/')) {
    onStatus('Preparing…');
    const { blob, name } = await prepareImage(file);
    onStatus('Uploading…');
    return send(`/api/media${query}`, blob, name, onProgress);
  }
  onStatus('Uploading…');
  return send(`/api/media${query}`, file, file.name, onProgress);
}
