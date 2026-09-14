// Helper API — semua request ke backend (same-origin; di dev di-proxy Vite)

const KEY = () => localStorage.getItem('kyps_key') || '';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = KEY();
  if (key) headers['x-app-key'] = key;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) throw new ApiError(401, 'App key salah');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Terjadi kesalahan');
  return data;
}

/** Upload video dengan progress (XHR) */
export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    const key = KEY();
    if (key) xhr.setRequestHeader('x-app-key', key);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data.error || 'Upload gagal'));
      } catch {
        reject(new Error('Upload gagal (respon tidak valid)'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload gagal — periksa koneksi'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 15 * 60 * 1000;
    const form = new FormData();
    form.append('video', file);
    xhr.send(form);
  });
}
