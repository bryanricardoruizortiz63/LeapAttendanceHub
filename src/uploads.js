import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { HttpError } from './util.js';

const TYPES = [
  { ext: '.pdf', mime: 'application/pdf' },
  { ext: '.jpg', mime: 'image/jpeg', alt: ['.jpeg'] },
  { ext: '.png', mime: 'image/png' },
  { ext: '.webp', mime: 'image/webp' },
  { ext: '.gif', mime: 'image/gif' },
  { ext: '.heic', mime: 'image/heic' },
  { ext: '.heif', mime: 'image/heif' },
  { ext: '.doc', mime: 'application/msword' },
  { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];

// Some phones send HEIC photos or Office docs with a generic MIME type, so fall back to the extension.
function detectType(file) {
  const byMime = TYPES.find((t) => t.mime === file.mimetype);
  if (byMime) return byMime;
  const ext = path.extname(file.originalname || '').toLowerCase();
  return TYPES.find((t) => t.ext === ext || t.alt?.includes(ext)) || null;
}

export const INLINE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function uploadDir(config, schoolId) {
  return path.join(config.dataDir, 'uploads', String(schoolId));
}

export function createUpload(config) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const dir = uploadDir(config, req.user.school_id);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      const type = detectType(file);
      file.detectedMime = type.mime;
      cb(null, crypto.randomBytes(16).toString('hex') + type.ext);
    },
  });

  return multer({
    storage,
    defParamCharset: 'utf8',
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 5, fields: 20, fieldSize: 20000 },
    fileFilter(req, file, cb) {
      if (detectType(file)) cb(null, true);
      else cb(new HttpError(400, `Tipo de archivo no permitido (${file.originalname}). Usa PDF, foto o Word.`));
    },
  });
}

export function removeFiles(files) {
  for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
}

export function uploadErrorMessage(err, config) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return `Cada archivo debe pesar menos de ${config.maxUploadMb} MB.`;
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return 'Puedes subir hasta 5 archivos.';
    return 'No se pudo procesar el archivo.';
  }
  return null;
}
