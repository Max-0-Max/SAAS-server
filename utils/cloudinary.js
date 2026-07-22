const cloudinary = require('cloudinary').v2;

let configured = false;
function ensureConfigured() {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  configured = true;
}

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

/**
 * Uploads a file straight from an in-memory buffer (multer memoryStorage) —
 * deliberately never writes to local disk, since that doesn't reliably
 * persist on serverless platforms like Vercel.
 */
function uploadBuffer(buffer, { folder = 'nexus/attachments', filename } = {}) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder, filename_override: filename, use_filename: true, unique_filename: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function deleteAsset(publicId) {
  ensureConfigured();
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'auto' });
  } catch (err) {
    console.error('Cloudinary delete failed:', publicId, err.message);
  }
}

module.exports = { uploadBuffer, deleteAsset, isConfigured };
