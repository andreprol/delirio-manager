'use strict';

// Gera URLs assinadas (SAS) de upload (escrita) e download (leitura) pro
// MESMO blob, pra transferência de arquivo operador→máquina remota
// (Acesso Remoto). Bytes do arquivo nunca passam por este servidor — o
// Dashboard sobe direto pro Blob com uploadUrl, e o companion baixa direto
// do Blob com downloadUrl. Ver docs/superpowers/specs/
// 2026-11-11-acesso-remoto-winkey-file-transfer-design.md.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require('@azure/storage-blob');

const CONFIG_PATH    = path.join(__dirname, '..', 'config.json');
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — ver spec, folga sobre instalador tipico
const SAS_TTL_MS     = 15 * 60 * 1000;         // 15min — mesmo valor aprovado no spec

function loadBlobStorageConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cfg = {};
  }
  if (!cfg.blobStorage || !cfg.blobStorage.accountName || !cfg.blobStorage.accountKey) {
    throw new Error('blobStorage não configurado em config.json (accountName/accountKey)');
  }
  return cfg.blobStorage;
}

// sanitizeFileName evita path traversal/caracteres invalidos de blob name —
// mantem so o nome final, sem diretorios.
function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[^\w.\-áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ ]/g, '_');
}

// generateFileTransferUrls({fileName, fileSize}) -> {uploadUrl, downloadUrl, blobName}
function generateFileTransferUrls({ fileName, fileSize }) {
  if (fileSize > MAX_FILE_BYTES) {
    throw new Error(`Arquivo acima do limite de 2GB (recebido: ${fileSize} bytes)`);
  }

  const { accountName, accountKey, container } = loadBlobStorageConfig();
  const credential = new StorageSharedKeyCredential(accountName, accountKey);

  const safeFileName = sanitizeFileName(fileName);
  const blobName = `${crypto.randomUUID()}-${safeFileName}`;

  const now       = new Date();
  const startsOn  = new Date(now.getTime() - 5 * 60 * 1000); // folga de relogio
  const expiresOn = new Date(now.getTime() + SAS_TTL_MS);

  const baseParams = {
    containerName: container,
    blobName,
    startsOn,
    expiresOn,
    protocol: 'https',
  };

  const uploadSas = generateBlobSASQueryParameters(
    { ...baseParams, permissions: BlobSASPermissions.parse('cw') },
    credential,
  ).toString();

  const downloadSas = generateBlobSASQueryParameters(
    { ...baseParams, permissions: BlobSASPermissions.parse('r') },
    credential,
  ).toString();

  const blobUrlBase = `https://${accountName}.blob.core.windows.net/${container}/${encodeURIComponent(blobName)}`;

  return {
    uploadUrl:   `${blobUrlBase}?${uploadSas}`,
    downloadUrl: `${blobUrlBase}?${downloadSas}`,
    blobName,
  };
}

module.exports = { generateFileTransferUrls, MAX_FILE_BYTES };
