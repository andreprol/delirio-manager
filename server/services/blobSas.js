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
  const base = path.basename(fileName).replace(/[^\w.\-áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ ]/g, '_');
  // Azure Blob Storage rejeita/torna inacessivel blob terminado em ponto ou
  // espaco — so o caractere FINAL importa, pontos no meio (instalador.exe)
  // seguem normais.
  return base.replace(/[\s.]+$/, '');
}

// generateFileTransferUrls({fileName, fileSize}) -> {uploadUrl, downloadUrl, blobName}
// fileSize é OPCIONAL de propósito: usado na direção operador->remoto (o
// browser já sabe o tamanho do arquivo antes de pedir a SAS, ver
// routes/live.js /file/upload-url) pra rejeitar cedo, mas não existe ainda
// na direção remoto->operador (/file/download-url) -- o operador só informa
// um CAMINHO no remoto, o tamanho real só é descoberto quando o companion
// abre o arquivo pra ler. `undefined` pula a checagem explicitamente (não é
// um acidente de `undefined > número` ser falsy) -- a MESMA função de
// geração de SAS serve as 2 direções, só quem chama decide se valida antes.
function generateFileTransferUrls({ fileName, fileSize }) {
  if (fileSize !== undefined && fileSize > MAX_FILE_BYTES) {
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
