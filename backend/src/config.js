
require('dotenv').config();

function need(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

module.exports = {
  nocodb: {
    url: need('NOCODB_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    token: need('NOCODB_API_TOKEN', ''),
    baseName: need('NOCODB_BASE_NAME', 'GATE99'),
    baseId: need('NOCODB_BASE_ID', '').trim(),
  },
  server: {
    port: Number(need('PORT', 3000)),
  },
  email: {
    user: need('EMAIL_USER', ''),
    pass: need('EMAIL_PASS', ''),
    fromName: need('EMAIL_FROM_NAME', 'GATE99'),
  },
  uploads: {
    dir: need('UPLOAD_DIR', './uploads'),
    publicBaseUrl: need('PUBLIC_UPLOAD_BASE_URL', 'http://localhost:3000/uploads'),
  },
};
